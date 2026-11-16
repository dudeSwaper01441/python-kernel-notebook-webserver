#!/usr/bin/env python3
"""Cobalt kernel.

A persistent CPython process that speaks newline-delimited JSON on stdin/stdout.
The server spawns one of these per runtime, so variables, imports and functions
survive between notebook cells - just like a real Jupyter kernel.
"""

from __future__ import annotations

import ast
import base64
import builtins
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import types
from xml.sax.saxutils import escape as xml_escape

# The *real* stdout is our protocol channel. Everything the user prints is
# redirected through StreamWriter and forwarded as structured messages.
PROTOCOL_OUT = sys.stdout
PROTOCOL_IN = sys.stdin
for _stream in (PROTOCOL_OUT, PROTOCOL_IN):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

_write_lock = threading.Lock()
CURRENT_ID: str | None = None
EXEC_COUNT = 0
KERNEL_START = time.time()

USER_NS: dict[str, object] = {
    "__name__": "__main__",
    "__builtins__": builtins,
    "__doc__": None,
    "__package__": None,
    "__loader__": None,
    "__spec__": None,
}


def send(message: dict) -> None:
    """Write one JSON message to the protocol channel (thread safe)."""
    try:
        payload = json.dumps(message, ensure_ascii=False, default=str)
    except Exception:
        payload = json.dumps({"type": "error", "id": CURRENT_ID,
                              "ename": "SerializationError",
                              "evalue": "Could not serialize output",
                              "traceback": []})
    with _write_lock:
        try:
            PROTOCOL_OUT.write(payload + "\n")
            PROTOCOL_OUT.flush()
        except Exception:
            pass


class StreamWriter(io.TextIOBase):
    """A file-like object that turns writes into stream messages."""

    def __init__(self, name: str) -> None:
        self.name = name

    def write(self, text):  # type: ignore[override]
        if not isinstance(text, str):
            text = str(text)
        if text:
            send({"type": "stream", "id": CURRENT_ID, "name": self.name, "text": text})
        return len(text)

    def writelines(self, lines):  # type: ignore[override]
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    @property
    def encoding(self):  # type: ignore[override]
        return "utf-8"

    @property
    def errors(self):  # type: ignore[override]
        return "replace"


USER_STDOUT = StreamWriter("stdout")
USER_STDERR = StreamWriter("stderr")


def install_streams() -> None:
    sys.stdout = USER_STDOUT
    sys.stderr = USER_STDERR


install_streams()


# --------------------------------------------------------------------------- #
# Rich display
# --------------------------------------------------------------------------- #

MIME_METHODS = [
    ("text/html", "_repr_html_"),
    ("image/svg+xml", "_repr_svg_"),
    ("image/png", "_repr_png_"),
    ("image/jpeg", "_repr_jpeg_"),
    ("text/markdown", "_repr_markdown_"),
    ("application/json", "_repr_json_"),
]


class HTML(str):
    def _repr_html_(self) -> str:
        return str(self)


class Markdown(str):
    def _repr_markdown_(self) -> str:
        return str(self)


class SVG(str):
    def _repr_svg_(self) -> str:
        return str(self)


def _b64(value) -> str | None:
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, str):
        return value.strip()
    return None


def _safe_repr(value, limit: int = 20000) -> str:
    try:
        text = repr(value)
    except Exception:
        return f"<{type(value).__name__} object>"
    if len(text) > limit:
        text = text[:limit] + "\n…"
    return text


def _figure_module():
    return sys.modules.get("matplotlib.figure")


def is_figure(value) -> bool:
    module = _figure_module()
    return module is not None and isinstance(value, module.Figure)


def figure_to_data(figure) -> dict:
    buffer = io.BytesIO()
    figure.savefig(
        buffer,
        format="png",
        dpi=figure.dpi,
        bbox_inches="tight",
        facecolor=figure.get_facecolor(),
        edgecolor="none",
    )
    return {"image/png": base64.b64encode(buffer.getvalue()).decode("ascii")}


def encode_value(value) -> dict:
    """Build a Jupyter-style mime bundle for a Python object."""
    data: dict[str, object] = {}

    if is_figure(value):
        try:
            data.update(figure_to_data(value))
        except Exception:
            pass

    for mime, method_name in MIME_METHODS:
        if mime in data:
            continue
        method = getattr(value, method_name, None)
        if not callable(method):
            continue
        try:
            rendered = method()
        except Exception:
            continue
        if rendered is None:
            continue
        if mime in ("image/png", "image/jpeg"):
            rendered = _b64(rendered)
            if rendered is None:
                continue
        elif mime == "application/json":
            try:
                json.dumps(rendered)
            except Exception:
                continue
        data[mime] = rendered

    if "text/plain" not in data:
        data["text/plain"] = _safe_repr(value)
    return data


def display(*objects, **_kwargs) -> None:
    for obj in objects:
        if is_figure(obj):
            try:
                send({"type": "display", "id": CURRENT_ID, "data": figure_to_data(obj)})
            except Exception as exc:  # pragma: no cover - best effort
                send({"type": "error", "id": CURRENT_ID, "ename": type(exc).__name__,
                      "evalue": str(exc), "traceback": [str(exc)]})
            continue
        send({"type": "display", "id": CURRENT_ID, "data": encode_value(obj)})


def displayhook(value) -> None:
    if value is None:
        return
    builtins._ = value
    send({"type": "result", "id": CURRENT_ID, "data": encode_value(value)})


sys.displayhook = displayhook


def flush_figures() -> None:
    """Send any open matplotlib figures to the frontend and close them."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    try:
        numbers = list(plt.get_fignums())
    except Exception:
        return
    for number in numbers:
        try:
            figure = plt.figure(number)
            send({"type": "display", "id": CURRENT_ID, "data": figure_to_data(figure)})
        except Exception:
            pass
        finally:
            try:
                plt.close(figure)
            except Exception:
                pass


def patch_pyplot() -> None:
    """Make plt.show() flush figures immediately instead of blocking."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None or getattr(plt.show, "_cobalt_patched", False):
        return
    try:
        def _show(*_args, **_kwargs):
            flush_figures()

        _show._cobalt_patched = True  # type: ignore[attr-defined]
        plt.show = _show
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Turtle graphics support
# --------------------------------------------------------------------------- #

_TURTLE_LAST_SVG: str | None = None
_TURTLE_LAST_SCREEN: int | None = None
_TURTLE_OUTPUT_IDS: dict[int, str] = {}
_TURTLE_PATCHED = False
_TURTLE_FLUSHING = False
_TURTLE_TOUCHED = False
_TURTLE_LAST_EMIT = 0.0
_TURTLE_FRAMES = 0
_TURTLE_ANIMATION_STARTED = 0.0
_TURTLE_FRAME_INTERVAL = 0.03
_TURTLE_SLOW_FRAME_INTERVAL = 0.1
_TURTLE_FAST_FRAMES = 900
_TURTLE_FAST_SECONDS = 30.0


def _turtle_noop(*_args, **_kwargs) -> None:
    return None


def reset_turtle_animation() -> None:
    global _TURTLE_LAST_EMIT, _TURTLE_FRAMES, _TURTLE_ANIMATION_STARTED
    global _TURTLE_TOUCHED, _TURTLE_LAST_SVG, _TURTLE_LAST_SCREEN
    _TURTLE_LAST_EMIT = 0.0
    _TURTLE_FRAMES = 0
    _TURTLE_ANIMATION_STARTED = time.monotonic()
    _TURTLE_TOUCHED = False
    # Each cell gets its own turtle output even if the drawing is unchanged.
    _TURTLE_LAST_SVG = None
    _TURTLE_LAST_SCREEN = None


def clear_turtle_canvas() -> None:
    """Erase the previous cell's drawing before a new cell starts.

    The turtle screen lives for the whole kernel session, so without this a
    cell would draw on top of whatever the previous cell left behind. Resetting
    the screen clears every turtle's lines and re-centers the turtles. Touch
    and flush callbacks are suppressed so the reset itself does not emit an
    empty turtle output.
    """
    global _TURTLE_FLUSHING

    module = sys.modules.get("turtle")
    if module is None:
        return
    screen = getattr(getattr(module, "Turtle", None), "_screen", None)
    if screen is None:
        return

    previous_flushing = _TURTLE_FLUSHING
    _TURTLE_FLUSHING = True
    try:
        screen.reset()
    except Exception:
        pass
    finally:
        _TURTLE_FLUSHING = previous_flushing


def _turtle_should_animate(screen) -> bool:
    if CURRENT_ID is None or getattr(screen, "_tracing", 1) == 0:
        return False
    if getattr(screen, "_delayvalue", 10) <= 0:
        return False
    try:
        return any(getattr(pen, "_speed", 0) for pen in screen.turtles())
    except Exception:
        return False


def maybe_flush_turtle(screen) -> None:
    """Send a throttled frame while turtle is drawing."""
    global _TURTLE_LAST_EMIT, _TURTLE_FRAMES, _TURTLE_TOUCHED

    if CURRENT_ID is None or _TURTLE_FLUSHING:
        return
    _TURTLE_TOUCHED = True
    if not _turtle_should_animate(screen):
        return

    # Stream the start of the drawing at full speed, then keep updating at a
    # slower rate so long drawings still show progress instead of freezing.
    # Skip frames instead of sleeping: sleeping here would block turtle's own
    # drawing loop and make long cells crawl.
    now = time.monotonic()
    elapsed = now - _TURTLE_ANIMATION_STARTED
    interval = _TURTLE_FRAME_INTERVAL
    if _TURTLE_FRAMES >= _TURTLE_FAST_FRAMES or elapsed > _TURTLE_FAST_SECONDS:
        interval = _TURTLE_SLOW_FRAME_INTERVAL
    if now - _TURTLE_LAST_EMIT < interval:
        return

    _TURTLE_LAST_EMIT = now
    _TURTLE_FRAMES += 1
    flush_turtle(screen, progressive=True)


def _tk_option(options: dict, name: str, default: str = "") -> str:
    value = options.get(name, default)
    if isinstance(value, tuple):
        value = value[-1] if value else default
    return "" if value is None else str(value)


def _svg_color(value: str, default: str | None = None) -> str | None:
    value = str(value or "").strip()
    if not value or value.lower() == "none":
        return default
    # Tk's platform theme colors are not valid CSS colors.
    if value.lower().startswith("system"):
        return default
    return value


def _svg_number(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _svg_font(font: str) -> str:
    """Translate a Tk font description into a CSS font shorthand."""
    parts = str(font or "").split()
    size = 12.0
    weight = "normal"
    style = "normal"
    family: list[str] = []
    for part in parts:
        low = part.lower()
        if re.fullmatch(r"-?\d+(?:\.\d+)?", part):
            size = abs(float(part)) or 12.0
        elif low in ("bold", "normal", "italic", "roman", "underline", "overstrike"):
            if low == "bold":
                weight = "bold"
            elif low == "italic":
                style = "italic"
        else:
            family.append(part)
    family_text = " ".join(family) or "sans-serif"
    return f"font-family:{xml_escape(family_text)};font-size:{size:g}px;font-weight:{weight};font-style:{style}"


def _turtle_item_svg(canvas, item) -> tuple[str, tuple[float, float, float, float] | None]:
    try:
        kind = canvas.type(item)
        coords = [float(value) for value in canvas.coords(item)]
        options = canvas.itemconfigure(item)
    except Exception:
        return "", None

    if _tk_option(options, "state").lower() == "hidden":
        return "", None

    def color(name: str, default: str | None = None) -> str | None:
        return _svg_color(_tk_option(options, name), default)

    width = _svg_number(_tk_option(options, "width", "1"), 1.0)
    common = []
    dash = _tk_option(options, "dash")
    if dash:
        common.append(f'stroke-dasharray="{xml_escape(dash)}"')

    if kind == "line":
        fill = color("fill")
        if not fill or len(coords) < 4:
            return "", None
        points = " ".join(f"{coords[i]:.3f},{coords[i + 1]:.3f}" for i in range(0, len(coords) - 1, 2))
        attrs = [
            f'points="{points}"',
            'fill="none"',
            f'stroke="{xml_escape(fill)}"',
            f'stroke-width="{max(width, 1.0):g}"',
        ]
        cap = _tk_option(options, "capstyle").lower()
        if cap in ("round", "projecting", "butt"):
            attrs.append(f'stroke-linecap="{cap}"')
        join = _tk_option(options, "joinstyle").lower()
        if join in ("round", "bevel", "miter"):
            attrs.append(f'stroke-linejoin="{join}"')
        attrs.extend(common)
        return f"<polyline {' '.join(attrs)}/>", _item_bounds(canvas, item, coords)

    if kind == "polygon":
        fill = color("fill", "none") or "none"
        outline = color("outline", "none") or "none"
        if fill == "none" and outline == "none":
            return "", None
        if len(coords) < 6:
            return "", None
        points = " ".join(f"{coords[i]:.3f},{coords[i + 1]:.3f}" for i in range(0, len(coords) - 1, 2))
        attrs = [f'points="{points}"', f'fill="{xml_escape(fill)}"']
        if outline != "none":
            attrs.extend([
                f'stroke="{xml_escape(outline)}"',
                f'stroke-width="{max(width, 1.0):g}"',
                'stroke-linejoin="round"',
            ])
        attrs.extend(common)
        return f"<polygon {' '.join(attrs)}/>", _item_bounds(canvas, item, coords)

    if kind == "oval" and len(coords) >= 4:
        x1, y1, x2, y2 = coords[:4]
        fill = color("fill", "none") or "none"
        outline = color("outline", "none") or "none"
        if fill == "none" and outline == "none":
            return "", None
        attrs = [
            f'cx="{(x1 + x2) / 2:.3f}"',
            f'cy="{(y1 + y2) / 2:.3f}"',
            f'rx="{abs(x2 - x1) / 2:.3f}"',
            f'ry="{abs(y2 - y1) / 2:.3f}"',
            f'fill="{xml_escape(fill)}"',
        ]
        if outline != "none":
            attrs.extend([f'stroke="{xml_escape(outline)}"', f'stroke-width="{max(width, 1.0):g}"'])
        return f"<ellipse {' '.join(attrs)}/>", _item_bounds(canvas, item, coords)

    if kind == "rectangle" and len(coords) >= 4:
        x1, y1, x2, y2 = coords[:4]
        fill = color("fill", "none") or "none"
        outline = color("outline", "none") or "none"
        if fill == "none" and outline == "none":
            return "", None
        attrs = [
            f'x="{min(x1, x2):.3f}"',
            f'y="{min(y1, y2):.3f}"',
            f'width="{abs(x2 - x1):.3f}"',
            f'height="{abs(y2 - y1):.3f}"',
            f'fill="{xml_escape(fill)}"',
        ]
        if outline != "none":
            attrs.extend([f'stroke="{xml_escape(outline)}"', f'stroke-width="{max(width, 1.0):g}"'])
        return f"<rect {' '.join(attrs)}/>", _item_bounds(canvas, item, coords)

    if kind == "text" and len(coords) >= 2:
        text = _tk_option(options, "text")
        if not text:
            return "", None
        fill = color("fill", "black") or "black"
        anchor = _tk_option(options, "anchor", "center").lower()
        text_anchor, baseline = {
            "nw": ("start", "hanging"),
            "n": ("middle", "hanging"),
            "ne": ("end", "hanging"),
            "w": ("start", "middle"),
            "center": ("middle", "middle"),
            "e": ("end", "middle"),
            "sw": ("start", "auto"),
            "s": ("middle", "auto"),
            "se": ("end", "auto"),
        }.get(anchor, ("middle", "middle"))
        attrs = [
            f'x="{coords[0]:.3f}"',
            f'y="{coords[1]:.3f}"',
            f'fill="{xml_escape(fill)}"',
            f'text-anchor="{text_anchor}"',
            f'dominant-baseline="{baseline}"',
            f'style="{_svg_font(_tk_option(options, "font"))}"',
        ]
        return f"<text {' '.join(attrs)}>{xml_escape(text)}</text>", _item_bounds(canvas, item, coords)

    # Image, bitmap, arc, window and other items are not produced by turtle's
    # default drawing operations, so leave them out rather than guessing.
    return "", None


def _item_bounds(canvas, item, coords) -> tuple[float, float, float, float] | None:
    try:
        bbox = canvas.bbox(item)
        if bbox and len(bbox) == 4:
            return (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    except Exception:
        pass
    xs = coords[0::2]
    ys = coords[1::2]
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _turtle_canvas_svg(canvas, screen) -> str:
    try:
        background = _svg_color(canvas.cget("bg"), "#ffffff") or "#ffffff"
    except Exception:
        background = "#ffffff"

    try:
        canvas_width = float(getattr(canvas, "canvwidth", 0) or getattr(screen, "canvwidth", 0) or 400)
        canvas_height = float(getattr(canvas, "canvheight", 0) or getattr(screen, "canvheight", 0) or 300)
    except Exception:
        canvas_width, canvas_height = 400.0, 300.0

    try:
        items = list(canvas.find_all())
    except Exception:
        return ""

    rendered: list[str] = []
    boxes: list[tuple[float, float, float, float]] = []
    for item in items:
        markup, box = _turtle_item_svg(canvas, item)
        if markup:
            rendered.append(markup)
        if box:
            boxes.append(box)

    if not rendered and background.lower() in ("#ffffff", "white"):
        return ""

    min_x, min_y = -canvas_width / 2, -canvas_height / 2
    max_x, max_y = canvas_width / 2, canvas_height / 2
    if boxes:
        box_min_x = min(box[0] for box in boxes)
        box_min_y = min(box[1] for box in boxes)
        box_max_x = max(box[2] for box in boxes)
        box_max_y = max(box[3] for box in boxes)
        min_x, min_y = min(min_x, box_min_x), min(min_y, box_min_y)
        max_x, max_y = max(max_x, box_max_x), max(max_y, box_max_y)

    padding = max(8.0, min(canvas_width, canvas_height) * 0.04)
    min_x -= padding
    min_y -= padding
    max_x += padding
    max_y += padding
    view_width = max(max_x - min_x, 1.0)
    view_height = max(max_y - min_y, 1.0)

    title = str(getattr(screen, "_title", "") or "").strip()
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" ',
        f'viewBox="{min_x:.3f} {min_y:.3f} {view_width:.3f} {view_height:.3f}" ',
        f'width="{view_width:.0f}" height="{view_height:.0f}" ',
        f'style="max-width:100%;height:auto;display:block;background:{xml_escape(background)};border-radius:9px" ',
        'shape-rendering="geometricPrecision">',
    ]
    if title:
        parts.append(f"<title>{xml_escape(title)}</title>")
    parts.append(
        f'<rect x="{min_x:.3f}" y="{min_y:.3f}" width="{view_width:.3f}" '
        f'height="{view_height:.3f}" fill="{xml_escape(background)}"/>'
    )
    parts.extend(rendered)
    parts.append("</svg>")
    return "".join(parts)


def flush_turtle(screen=None, progressive: bool = False) -> None:
    """Render the current turtle canvas as inline SVG output.

    Progressive frames reuse the same ``display_id`` so the browser can
    replace the previous frame instead of appending a new output for every
    step of the drawing.
    """
    global _TURTLE_LAST_SVG, _TURTLE_LAST_SCREEN, _TURTLE_FLUSHING

    if _TURTLE_FLUSHING:
        return
    module = sys.modules.get("turtle")
    if module is None:
        return
    if screen is None:
        screen = getattr(getattr(module, "Turtle", None), "_screen", None)
    if screen is None:
        return

    _TURTLE_FLUSHING = True
    try:
        try:
            screen.update()
        except Exception:
            pass

        canvas = getattr(screen, "_canvas", None)
        if canvas is None:
            return

        svg = _turtle_canvas_svg(canvas, screen)
        if not svg:
            return

        screen_id = id(screen)
        if svg == _TURTLE_LAST_SVG and screen_id == _TURTLE_LAST_SCREEN:
            return
        _TURTLE_LAST_SVG = svg
        _TURTLE_LAST_SCREEN = screen_id

        output_id = _TURTLE_OUTPUT_IDS.get(screen_id)
        if output_id is None:
            output_id = f"turtle-{screen_id}"
            _TURTLE_OUTPUT_IDS[screen_id] = output_id

        send({
            "type": "display",
            "id": CURRENT_ID,
            "display_id": output_id,
            "progressive": progressive,
            "data": {
                "image/svg+xml": svg,
                "text/plain": "Turtle graphics",
            },
        })
    finally:
        _TURTLE_FLUSHING = False


def install_turtle_support() -> None:
    """Patch the standard turtle module so it draws into notebook output.

    Turtle still uses a real Tk canvas (which gives us accurate colours,
    shapes, text and transforms); the window itself stays hidden and the
    canvas is serialized to SVG at the end of each cell.
    """
    global _TURTLE_PATCHED
    if _TURTLE_PATCHED:
        return
    try:
        import tkinter
        import turtle
    except Exception:
        return

    try:
        # Mark the cell as "turtle touched" whenever the turtle canvas is
        # mutated. This catches tracer(0) drawings, which never call update().
        canvas_cls = tkinter.Canvas
        mutating_methods = (
            "create_line", "create_polygon", "create_text", "create_image",
            "create_oval", "create_rectangle", "create_arc", "coords",
            "itemconfigure", "itemconfig", "delete", "config", "configure",
            "tag_raise", "tag_lower", "move", "moveto", "scale", "addtag",
            "insert",
        )
        for method_name in mutating_methods:
            original = getattr(canvas_cls, method_name, None)
            if original is None or getattr(original, "_cobalt_touch", False):
                continue

            def make_touch_wrapper(method):
                def touch_wrapper(self, *args, **kwargs):
                    global _TURTLE_TOUCHED
                    if CURRENT_ID is not None and not _TURTLE_FLUSHING:
                        _TURTLE_TOUCHED = True
                    return method(self, *args, **kwargs)

                touch_wrapper._cobalt_touch = True  # type: ignore[attr-defined]
                return touch_wrapper

            setattr(canvas_cls, method_name, make_touch_wrapper(original))
    except Exception:
        pass

    try:
        root_cls = getattr(turtle, "_Root", None)
        if root_cls is not None and not getattr(root_cls, "_cobalt_patched", False):
            original_root_init = root_cls.__init__

            def hidden_root_init(self, *args, **kwargs):
                original_root_init(self, *args, **kwargs)
                try:
                    self.withdraw()
                except Exception:
                    pass

            root_cls.__init__ = hidden_root_init
            root_cls._cobalt_patched = True

        base_cls = getattr(turtle, "TurtleScreen", None)
        if base_cls is not None:
            base_cls.mainloop = _turtle_noop

        screen_cls = getattr(turtle, "_Screen", None)
        if screen_cls is not None:
            screen_cls.mainloop = _turtle_noop
            screen_cls.exitonclick = _turtle_noop

            original_update = screen_cls._update

            def animated_update(self, *args, **kwargs):
                result = original_update(self, *args, **kwargs)
                try:
                    maybe_flush_turtle(self)
                except Exception:
                    pass
                return result

            screen_cls._update = animated_update

            original_destroy = screen_cls._destroy

            def visible_destroy(self):
                screen_id = id(self)
                try:
                    flush_turtle(self)
                except Exception:
                    pass
                result = original_destroy(self)
                _TURTLE_OUTPUT_IDS.pop(screen_id, None)
                # In a notebook, closing one turtle screen shouldn't make the
                # next turtle call raise Terminator. Let it start a new screen.
                try:
                    turtle.TurtleScreen._RUNNING = True
                except Exception:
                    pass
                return result

            screen_cls._destroy = visible_destroy

        # Module-level helpers are generated wrappers that can create a screen
        # implicitly. Keep them from entering Tk's event loop.
        turtle.mainloop = _turtle_noop
        turtle.done = _turtle_noop
        turtle.exitonclick = _turtle_noop
    except Exception:
        pass

    _TURTLE_PATCHED = True


# --------------------------------------------------------------------------- #
# Shell escape support (!command)
# --------------------------------------------------------------------------- #

def run_shell(command: str) -> None:
    command = str(command).strip()
    if not command:
        return
    try:
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except Exception as exc:
        raise RuntimeError(f"Could not run shell command: {exc}") from exc

    assert process.stdout is not None
    for line in iter(process.stdout.readline, ""):
        print(line, end="")
    process.stdout.close()
    code = process.wait()
    if code:
        print(f"[exit code {code}]")


# --------------------------------------------------------------------------- #
# input() support
# --------------------------------------------------------------------------- #

def cobalt_input(prompt: str = "") -> str:
    """Ask the browser for a value without blocking the kernel process forever."""
    send({"type": "input_request", "id": CURRENT_ID, "prompt": str(prompt)})
    while True:
        line = PROTOCOL_IN.readline()
        if not line:
            raise EOFError("Kernel input channel closed")
        try:
            message = json.loads(line)
        except Exception:
            continue
        kind = message.get("type")
        if kind == "input" and message.get("id") in (None, CURRENT_ID):
            return str(message.get("value", ""))
        if kind == "interrupt":
            raise KeyboardInterrupt("Execution interrupted")


# --------------------------------------------------------------------------- #
# Execution
# --------------------------------------------------------------------------- #

SHELL_PATTERN = re.compile(r"^(?P<indent>[ \t]*)!(?!=)(?P<command>.*)$", re.MULTILINE)


def transform_shell_escapes(source: str) -> str:
    if "!" not in source:
        return source
    return SHELL_PATTERN.sub(
        lambda match: f"{match.group('indent')}__cobalt_shell__({match.group('command').strip()!r})",
        source,
    )


def send_syntax_error(exc: SyntaxError) -> None:
    lines = "".join(traceback.format_exception_only(type(exc), exc)).rstrip("\n").split("\n")
    send({
        "type": "error",
        "id": CURRENT_ID,
        "ename": type(exc).__name__,
        "evalue": exc.msg,
        "traceback": lines,
        "syntax": True,
    })


def send_exception(exc: BaseException) -> None:
    tb = exc.__traceback__
    if tb is not None:
        tb = tb.tb_next  # drop this function's frame
    try:
        text = "".join(traceback.format_exception(type(exc), exc, tb)).rstrip("\n")
    except Exception:
        text = f"{type(exc).__name__}: {exc}"
    send({
        "type": "error",
        "id": CURRENT_ID,
        "ename": type(exc).__name__,
        "evalue": str(exc),
        "traceback": text.split("\n"),
    })


def execute(code: str, exec_id: str | None) -> None:
    global CURRENT_ID, EXEC_COUNT
    CURRENT_ID = exec_id
    EXEC_COUNT += 1
    install_streams()
    reset_turtle_animation()
    clear_turtle_canvas()
    started = time.perf_counter()
    status = "ok"

    send({"type": "start", "id": exec_id, "count": EXEC_COUNT})

    try:
        source = transform_shell_escapes(code)
        tree = ast.parse(source, filename="<cell>", mode="exec")
        if tree.body:
            last = tree.body[-1]
            if isinstance(last, ast.Expr):
                if len(tree.body) > 1:
                    prefix = ast.Module(body=tree.body[:-1], type_ignores=[])
                    exec(compile(prefix, "<cell>", "exec", dont_inherit=True), USER_NS)
                expression = ast.Expression(body=last.value)
                value = eval(compile(expression, "<cell>", "eval", dont_inherit=True), USER_NS)
                displayhook(value)
            else:
                exec(compile(tree, "<cell>", "exec", dont_inherit=True), USER_NS)
    except SyntaxError as exc:
        status = "error"
        send_syntax_error(exc)
    except BaseException as exc:  # noqa: BLE001 - user code may raise anything
        status = "error"
        send_exception(exc)
    finally:
        try:
            patch_pyplot()
            flush_figures()
        except Exception:
            pass
        try:
            if _TURTLE_TOUCHED:
                flush_turtle()
        except Exception:
            pass
        install_streams()
        duration = time.perf_counter() - started
        send({"type": "done", "id": exec_id, "duration": duration, "status": status})
        CURRENT_ID = None


# --------------------------------------------------------------------------- #
# Introspection
# --------------------------------------------------------------------------- #

HIDDEN_NAMES = {"display", "HTML", "Markdown", "SVG", "__cobalt_shell__", "input"}


def inspect_namespace(request_id: str | None) -> None:
    items = []
    for name, value in list(USER_NS.items()):
        if name.startswith("__") or name in HIDDEN_NAMES:
            continue
        if isinstance(value, types.ModuleType):
            continue
        if callable(value) and getattr(value, "__module__", "") in ("builtins", "sys"):
            continue
        try:
            rendered = repr(value)
        except Exception:
            rendered = f"<{type(value).__name__}>"
        if len(rendered) > 240:
            rendered = rendered[:240] + "…"
        items.append({
            "name": name,
            "type": type(value).__name__,
            "repr": rendered,
        })
    items.sort(key=lambda item: item["name"].lower())
    send({"type": "vars", "id": request_id, "items": items, "count": len(items)})


# --------------------------------------------------------------------------- #
# Bootstrap
# --------------------------------------------------------------------------- #

def available_packages() -> list[str]:
    import importlib.util

    found = []
    for name in ("numpy", "pandas", "matplotlib", "scipy", "sklearn", "PIL", "sympy", "requests"):
        try:
            if importlib.util.find_spec(name) is not None:
                found.append(name)
        except Exception:
            continue
    return found


def main() -> None:
    USER_NS.update({
        "display": display,
        "HTML": HTML,
        "Markdown": Markdown,
        "SVG": SVG,
        "input": cobalt_input,
        "__cobalt_shell__": run_shell,
    })
    try:
        install_turtle_support()
    except Exception:
        pass
    send({
        "type": "ready",
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "cwd": os.getcwd(),
        "packages": available_packages(),
        "started": KERNEL_START,
    })

    for line in PROTOCOL_IN:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except Exception:
            continue
        kind = message.get("type")
        if kind == "execute":
            execute(message.get("code", ""), message.get("id"))
        elif kind == "inspect":
            inspect_namespace(message.get("id"))
        elif kind == "ping":
            send({"type": "pong", "id": message.get("id")})
        elif kind == "shutdown":
            break


if __name__ == "__main__":
    main()
