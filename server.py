#!/usr/bin/env python3
"""Cobalt - a local-first Python notebook server.

Serves the notebook UI, manages a persistent CPython kernel, and streams
execution output back to the browser over Server-Sent Events.

Run:  python server.py
"""

from __future__ import annotations

import argparse
import collections
import json
import mimetypes
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
WORKSPACE = ROOT / "workspace"
NOTEBOOKS = ROOT / "notebooks"

USE_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
C_DIM = "\033[38;5;244m" if USE_COLOR else ""
C_ACCENT = "\033[38;5;110m" if USE_COLOR else ""
C_ERROR = "\033[38;5;203m" if USE_COLOR else ""
C_BOLD = "\033[1m" if USE_COLOR else ""
C_RESET = "\033[0m" if USE_COLOR else ""

MAX_BODY = 12 * 1024 * 1024  # 12 MB

MIME_OVERRIDES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def log(message: str) -> None:
    sys.stderr.write(f"{C_ACCENT}[cobalt]{C_RESET} {message}\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------- #
# Kernel process manager
# --------------------------------------------------------------------------- #

class KernelError(RuntimeError):
    pass


class Kernel:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.info: dict = {}
        self.started_at: float | None = None
        self.exec_lock = threading.Lock()
        self.stdin_lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=60)
        self.executions = 0

    # -- lifecycle ---------------------------------------------------------- #

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _kill(self) -> None:
        proc = self.proc
        self.proc = None
        if proc is None:
            return
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    try:
                        proc.wait(timeout=1.5)
                    except subprocess.TimeoutExpired:
                        pass
        except Exception:
            pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream:
                    stream.close()
            except Exception:
                pass

    def start(self, force: bool = False) -> dict:
        with self.lifecycle_lock:
            if not force and self.alive():
                return self.info

            self._kill()
            WORKSPACE.mkdir(parents=True, exist_ok=True)

            env = os.environ.copy()
            env["PYTHONUTF8"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            env["MPLBACKEND"] = "Agg"
            env.pop("PYTHONSTARTUP", None)

            flags = 0
            if os.name == "nt":
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

            proc = subprocess.Popen(
                [sys.executable, "-u", str(ROOT / "kernel.py")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(WORKSPACE),
                env=env,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=flags,
            )
            self.proc = proc
            self.stderr_tail.clear()

            threading.Thread(target=self._drain_stderr, args=(proc,), daemon=True).start()

            holder: dict[str, str | None] = {}

            def read_ready() -> None:
                try:
                    holder["line"] = proc.stdout.readline() if proc.stdout else None
                except Exception:
                    holder["line"] = None

            reader = threading.Thread(target=read_ready, daemon=True)
            reader.start()
            reader.join(15)

            if reader.is_alive() or not holder.get("line"):
                tail = " | ".join(self.stderr_tail) or "no response from kernel"
                self._kill()
                raise KernelError(f"Kernel failed to start: {tail}")

            try:
                info = json.loads(holder["line"] or "{}")
            except Exception as exc:
                self._kill()
                raise KernelError(f"Kernel handshake failed: {exc}") from exc

            if info.get("type") != "ready":
                self._kill()
                raise KernelError("Kernel did not send a ready message")

            self.info = info
            self.started_at = time.time()
            self.executions = 0
            log(f"kernel ready - Python {info.get('python')} ({info.get('cwd')})")
            return info

    def _drain_stderr(self, proc: subprocess.Popen) -> None:
        stream = proc.stderr
        if stream is None:
            return
        try:
            for line in iter(stream.readline, ""):
                line = line.rstrip()
                if not line:
                    continue
                self.stderr_tail.append(line)
                sys.stderr.write(f"{C_ERROR}[kernel]{C_RESET} {line}\n")
                sys.stderr.flush()
        except Exception:
            pass

    def restart(self) -> dict:
        with self.lifecycle_lock:
            self._kill()
            self.info = {}
            self.started_at = None
        return self.start()

    def interrupt(self) -> None:
        log("interrupt requested - restarting kernel")
        self._kill()
        self.info = {}
        self.started_at = None

    # -- io ----------------------------------------------------------------- #

    def write_stdin(self, message: dict) -> None:
        proc = self.proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            raise KernelError("Kernel is not running")
        payload = json.dumps(message, ensure_ascii=False) + "\n"
        with self.stdin_lock:
            proc.stdin.write(payload)
            proc.stdin.flush()

    def execute(self, code: str, exec_id: str):
        """Yield protocol messages for one execution."""
        try:
            self.start()
        except Exception as exc:
            yield {"type": "error", "id": exec_id, "ename": "KernelError",
                   "evalue": str(exc), "traceback": [str(exc)]}
            yield {"type": "done", "id": exec_id, "duration": 0.0, "status": "error"}
            return

        with self.exec_lock:
            self.executions += 1
            proc = self.proc
            if proc is None or proc.stdout is None:
                yield {"type": "error", "id": exec_id, "ename": "KernelError",
                       "evalue": "Kernel is not running", "traceback": []}
                yield {"type": "done", "id": exec_id, "duration": 0.0, "status": "error"}
                return

            try:
                self.write_stdin({"type": "execute", "id": exec_id, "code": code})
            except Exception as exc:
                yield {"type": "error", "id": exec_id, "ename": "KernelError",
                       "evalue": str(exc), "traceback": [str(exc)]}
                yield {"type": "done", "id": exec_id, "duration": 0.0, "status": "error"}
                return

            while True:
                try:
                    line = proc.stdout.readline()
                except Exception:
                    line = ""
                if not line:
                    tail = " | ".join(list(self.stderr_tail)[-4:])
                    message = "The kernel stopped unexpectedly."
                    if tail:
                        message += f"  {tail}"
                    yield {"type": "error", "id": exec_id, "ename": "KernelStopped",
                           "evalue": message, "traceback": [message]}
                    yield {"type": "done", "id": exec_id, "duration": 0.0,
                           "status": "error", "interrupted": True}
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except Exception:
                    continue
                if message.get("id") not in (None, exec_id):
                    continue
                yield message
                if message.get("type") == "done":
                    break

    # -- introspection ------------------------------------------------------ #

    def variables(self) -> dict:
        if not self.alive():
            return {"items": [], "count": 0, "busy": False, "alive": False}
        if not self.exec_lock.acquire(blocking=False):
            return {"items": [], "count": 0, "busy": True, "alive": True}
        try:
            request_id = uuid.uuid4().hex
            self.write_stdin({"type": "inspect", "id": request_id})
            proc = self.proc
            if proc is None or proc.stdout is None:
                return {"items": [], "count": 0, "busy": False, "alive": False}
            deadline = time.time() + 4.0
            while time.time() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except Exception:
                    continue
                if message.get("type") == "vars" and message.get("id") == request_id:
                    return {
                        "items": message.get("items", []),
                        "count": message.get("count", 0),
                        "busy": False,
                        "alive": True,
                    }
            return {"items": [], "count": 0, "busy": False, "alive": self.alive(),
                    "error": "The kernel did not respond."}
        except Exception as exc:
            return {"items": [], "count": 0, "busy": False, "alive": self.alive(),
                    "error": str(exc)}
        finally:
            self.exec_lock.release()

    def status(self) -> dict:
        return {
            "alive": self.alive(),
            "busy": self.exec_lock.locked(),
            "python": self.info.get("python"),
            "executable": self.info.get("executable"),
            "cwd": self.info.get("cwd"),
            "packages": self.info.get("packages", []),
            "uptime": round(time.time() - self.started_at, 1) if self.started_at else 0,
            "executions": self.executions,
        }


KERNEL = Kernel()


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    server_version = "Cobalt/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers ------------------------------------------------------------ #

    def handle(self) -> None:
        # Browsers routinely abort keep-alive and SSE connections; those
        # resets are expected, not server errors, so keep the console clean.
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    def log_message(self, fmt: str, *args) -> None:
        if "/api/status" in self.path:
            return
        sys.stderr.write(f"{C_DIM}{self.address_string()} - {fmt % args}{C_RESET}\n")

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        """Read (and cache) the request body so keep-alive stays in sync.

        Every POST route must drain its body, even routes that ignore it.
        Otherwise the leftover bytes are parsed as the next request line.
        """
        if getattr(self, "_body", None) is not None:
            return self._body
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._body = b""
            return self._body
        if length > MAX_BODY:
            # Drain oversized bodies without buffering them.
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._body = b""
            return self._body
        self._body = self.rfile.read(length)
        return self._body

    def _read_json(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        relative = urllib.parse.unquote(path.lstrip("/"))
        target = (WEB_ROOT / relative).resolve()
        try:
            target.relative_to(WEB_ROOT.resolve())
        except ValueError:
            self._json({"error": "not found"}, 404)
            return
        if not target.is_file():
            self._json({"error": "not found"}, 404)
            return
        data = target.read_bytes()
        content_type = MIME_OVERRIDES.get(target.suffix.lower())
        if content_type is None:
            content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- routes ------------------------------------------------------------- #

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/health":
                self._json({"ok": True})
            elif path == "/api/status":
                self._json(KERNEL.status())
            elif path == "/api/vars":
                self._json(KERNEL.variables())
            elif path == "/api/notebooks":
                self._json({"notebooks": list_notebooks()})
            elif path.startswith("/api/notebooks/"):
                self._serve_notebook(path.split("/", 3)[-1])
            else:
                self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log(traceback.format_exc())
            try:
                self._json({"error": "internal server error"}, 500)
            except Exception:
                pass

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        self._body = None
        try:
            # Always drain the body, including routes that ignore it, so that
            # HTTP/1.1 keep-alive connections remain usable afterwards.
            self._read_body()
            if path == "/api/execute":
                self._execute()
            elif path == "/api/restart":
                info = KERNEL.restart()
                self._json({"ok": True, "kernel": info})
            elif path == "/api/interrupt":
                KERNEL.interrupt()
                self._json({"ok": True})
            elif path == "/api/input":
                self._input()
            elif path == "/api/notebooks/save":
                self._save_notebook()
            else:
                self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log(traceback.format_exc())
            try:
                self._json({"error": "internal server error"}, 500)
            except Exception:
                pass

    def _execute(self) -> None:
        payload = self._read_json()
        code = payload.get("code", "")
        exec_id = str(payload.get("id") or uuid.uuid4().hex)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        def write_event(message: dict) -> None:
            data = "data: " + json.dumps(message, ensure_ascii=False) + "\n\n"
            self.wfile.write(data.encode("utf-8"))
            self.wfile.flush()

        try:
            for message in KERNEL.execute(code, exec_id):
                write_event(message)
        except (BrokenPipeError, ConnectionResetError):
            # The browser went away; make sure the kernel is not stuck forever.
            pass
        except Exception as exc:
            log(traceback.format_exc())
            try:
                write_event({"type": "error", "id": exec_id, "ename": "ServerError",
                             "evalue": str(exc), "traceback": [str(exc)]})
                write_event({"type": "done", "id": exec_id, "duration": 0.0, "status": "error"})
            except Exception:
                pass

    def _input(self) -> None:
        payload = self._read_json()
        try:
            KERNEL.write_stdin({
                "type": "input",
                "id": payload.get("id"),
                "value": payload.get("value", ""),
            })
            self._json({"ok": True})
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)}, 409)

    def _save_notebook(self) -> None:
        payload = self._read_json()
        notebook_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(payload.get("id", "")))[:80]
        notebook = payload.get("ipynb")
        if not notebook_id or not isinstance(notebook, dict) or not isinstance(notebook.get("cells"), list):
            self._json({"ok": False, "error": "invalid notebook"}, 400)
            return
        NOTEBOOKS.mkdir(parents=True, exist_ok=True)
        target = NOTEBOOKS / f"{notebook_id}.ipynb"
        target.write_text(json.dumps(notebook, ensure_ascii=False, indent=1), encoding="utf-8")
        self._json({"ok": True, "path": str(target.relative_to(ROOT)), "saved": time.time()})

    def _serve_notebook(self, notebook_id: str) -> None:
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", urllib.parse.unquote(notebook_id))[:80]
        target = (NOTEBOOKS / f"{safe}.ipynb").resolve()
        if not target.is_file():
            self._json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(target.read_bytes())


def list_notebooks() -> list[dict]:
    if not NOTEBOOKS.is_dir():
        return []
    items = []
    for path in sorted(NOTEBOOKS.glob("*.ipynb"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            title = path.stem
            for cell in data.get("cells", []):
                if cell.get("cell_type") == "markdown":
                    source = cell.get("source", "")
                    if isinstance(source, list):
                        source = "".join(source)
                    for line in source.splitlines():
                        if line.strip().startswith("#"):
                            title = line.strip("# ").strip() or title
                            break
                    if title != path.stem:
                        break
            items.append({
                "id": path.stem,
                "title": title,
                "cells": len(data.get("cells", [])),
                "updated": path.stat().st_mtime,
            })
        except Exception:
            continue
    return items


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def port_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Cobalt - Python notebooks in the browser")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-open", action="store_true", help="do not open a browser tab")
    parser.add_argument("--no-kernel", action="store_true", help="do not start the kernel eagerly")
    args = parser.parse_args()

    WORKSPACE.mkdir(parents=True, exist_ok=True)
    NOTEBOOKS.mkdir(parents=True, exist_ok=True)

    port = args.port
    for _ in range(25):
        if port_available(args.host, port):
            break
        port += 1
    else:
        log("could not find a free port")
        sys.exit(1)

    if not args.no_kernel:
        threading.Thread(target=lambda: _safe_start_kernel(), daemon=True).start()

    server = ThreadingHTTPServer((args.host, port), Handler)
    server.daemon_threads = True
    url = f"http://{args.host}:{port}/"

    print()
    print(f"  {C_BOLD}{C_ACCENT}Cobalt{C_RESET}  {C_DIM}Python notebooks in your browser{C_RESET}")
    print(f"  {C_DIM}->{C_RESET}  \033[4m{url}\033[0m" if USE_COLOR else f"  ->  {url}")
    print(f"  {C_DIM}workspace:{C_RESET} {WORKSPACE}")
    print(f"  {C_DIM}Ctrl+C to stop{C_RESET}")
    print()

    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
        log("shutting down")
    finally:
        KERNEL.interrupt()
        server.server_close()


def _safe_start_kernel() -> None:
    try:
        KERNEL.start()
    except Exception as exc:
        log(f"kernel unavailable: {exc}")


if __name__ == "__main__":
    main()
