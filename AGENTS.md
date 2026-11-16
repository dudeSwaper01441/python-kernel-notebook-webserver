# AGENTS.md — Cobalt

Cobalt is a local-first Python notebook that runs a real CPython kernel and streams output to a browser. The backend is Python standard library only; the frontend is vanilla HTML/CSS/JS with vendored libraries. There is no npm, bundler, or test framework.

This file is the fast path for AI agents. Read it before changing code.

## Ground rules

- Keep Cobalt local-first. Do not add accounts, telemetry, cloud calls, or runtime dependencies without a clear request.
- `notebooks/` and `workspace/` contain user data. Do not rewrite, delete, or "clean up" notebooks unless the task explicitly asks for it.
- Match the existing style: 2-space JavaScript, single quotes, semicolons; grouped CSS sections with custom properties; standard-library Python.
- Do not loosen the output sanitizer (`DOMPurify` settings in `web/js/app.part2.js`) without a security reason.
- `web/js/app.js` is generated. Edit the `app.part*.js` files, then rebuild it (see below). Never hand-edit only `app.js`.
- Verify UI changes in a browser at both wide and narrow widths. The app currently supports dark and light themes and must not create page-level horizontal overflow.

## Run and test

```powershell
# Normal development server (opens a browser, default port 8000; increments if busy)
python server.py

# Isolated test server: no browser launch, no eager kernel, fixed port
python server.py --port 8123 --no-open --no-kernel
```

Open `http://127.0.0.1:8123/` for the isolated server. Static assets are served with `Cache-Control: no-cache`; use a hard reload after changing JS/CSS. Server/kernel Python changes require restarting `server.py`.

There is no automated test suite. Scratch `cdp_*.py` and `shot*.png` files, when present, are browser-debugging artifacts rather than runtime code. They can be useful examples but may be stale.

### Optional browser verification with Chrome DevTools Protocol

A headless Chrome instance is often available on `http://127.0.0.1:9222`. Check `/json` for a page target, then drive it with `websocket-client` (already available in this environment). Useful checks:

```js
// No page-level horizontal overflow
document.documentElement.scrollWidth <= window.innerWidth

// A wide output is scrollable instead of painting outside its cell
(() => {
  const h = document.querySelector('.cell.code .out-html');
  return h && h.scrollWidth > h.clientWidth;
})()
```

Test at roughly 1440 px and 736 px wide. Also check `window.__cobaltErrors` after load; the app records uncaught errors there.

## File map

| Path | Responsibility |
| --- | --- |
| `server.py` | HTTP server, static files, API routes, SSE execution stream, kernel process management, notebook disk save/load |
| `kernel.py` | Persistent CPython subprocess; newline-delimited JSON protocol; captures stdout/stderr, trailing expressions, rich MIME, matplotlib, turtle, errors, `input()` |
| `web/index.html` | App shell, toolbar, sidebar, SVG icon sprite |
| `web/css/app.css` | Design system, themes, cell layout, CodeMirror theme, output styling, responsive rules |
| `web/js/app.part1.js` | Utilities, constants, welcome notebook content, local-storage persistence |
| `web/js/app.part2.js` | Notebook/cell rendering, CodeMirror setup, Markdown rendering, sanitizer |
| `web/js/app.part3.js` | Execution queue, SSE handling, output rendering, kernel status |
| `web/js/app.part4.js` | Menus, command palette, imports/exports, events, init |
| `web/js/app.js` | Generated concatenation of parts 1–4; served to the browser |
| `web/vendor/` | CodeMirror 5, marked, DOMPurify |
| `start.bat` | Windows launcher |

## Rebuild `web/js/app.js` (required after editing parts)

`app.js` is exactly the four part files joined with a newline between parts. From the repo root:

```powershell
@'
from pathlib import Path

root = Path("web/js")
parts = [
    (root / f"app.part{i}.js").read_text(encoding="utf-8")
    for i in range(1, 5)
]
(root / "app.js").write_text("\n".join(parts), encoding="utf-8", newline="")
print("rebuilt", root / "app.js")
'@ | python -
```

Verify the generated file is in sync:

```powershell
@'
from pathlib import Path

root = Path("web/js")
parts = [(root / f"app.part{i}.js").read_text(encoding="utf-8") for i in range(1, 5)]
app = (root / "app.js").read_text(encoding="utf-8")
print("in sync:", "\n".join(parts) == app)
'@ | python -
```

## Architecture notes

### Backend

- `server.py` exposes `/health`, `/api/status`, `/api/vars`, `/api/execute`, `/api/restart`, `/api/interrupt`, `/api/input`, `/api/notebooks`, `/api/notebooks/<id>`, and `/api/notebooks/save`.
- `/api/execute` responds with Server-Sent Events (`data: <json>\n\n`). The frontend reads the stream with `fetch` + `ReadableStream` and handles message types: `start`, `stream`, `result`, `display`, `error`, `input_request`, `done`.
- `kernel.py` is a long-lived process. Variables survive cells. Do not replace it with per-cell execution; persistence is a core feature.
- Notebooks autosave in browser `localStorage` (`cobalt.notebooks.v2`, `cobalt.current.v2`) and are mirrored to `notebooks/*.ipynb` via `/api/notebooks/save`.
- The server binds to `127.0.0.1` by default and has no authentication. Do not expose it publicly.

### Frontend

- `state.notebook.cells` is the source of truth. `renderNotebook()` rebuilds the DOM and CodeMirror editors from state; outputs are rebuilt via `renderOutputs()`.
- Code cells use CodeMirror 5 with `lineWrapping: true`. Long code lines should wrap, not force the page sideways.
- Output rendering happens in `web/js/app.part3.js` (`buildOutputElement`, `addOutput`, `upsertDisplayOutput`, `renderOutputs`).
- Rich output passes through `sanitizeHtml()` in `web/js/app.part2.js`. `style`/`script`/`iframe`/form controls are blocked or restricted; keep it that way.
- Markdown is rendered with `marked` and sanitized with `DOMPurify`. Wide Markdown tables are wrapped in `.table-scroll`.
- Colab-style `#@title` / `#@param` forms are parsed from the cell source in `app.part2.js` (`parseCellForm`, `refreshCellForm`). Form controls replace only the literal on their own source line, so `cell.source` stays the source of truth. A form hides its code by default; the `Show code` toggle is view-only and is not persisted.
- Theme colors and spacing come from CSS custom properties in `:root`, `[data-theme="dark"]`, and `[data-theme="light"]` in `web/css/app.css`. Prefer variables over hard-coded colors.

## Layout invariants (important)

- `body` has `overflow: hidden`; `.main` is the vertical scroll container. The notebook must never create a horizontal page scrollbar.
- `.cell` uses `grid-template-columns: 52px minmax(0, 1fr)`, and `.cell-body` has `min-width: 0`. Keep the zero minimums; removing them lets wide content push the whole layout.
- Code editors wrap. The vendored CodeMirror CSS leaves `.CodeMirror-scroll` at `overflow: scroll`; `app.css` overrides it for wrapped editors and hides the unused horizontal track. Do not remove those overrides without checking narrow widths and long lines.
- Output containers scroll horizontally (`.out-html`, `.out-md`, `.outputs`). A wide table or code block should be pannable inside the cell.
- SVG can paint outside its `viewBox` when `overflow: visible`; browser scroll containers ignore that ink overflow. `fitOverflowingSvg()` in `app.part3.js` detects this with `getBBox()` and expands the SVG viewport so `.out-html` gains a real horizontal scrollbar. If you change output insertion, keep calling it (it is scheduled on `requestAnimationFrame` because measurement requires the node to be attached).
- Markdown cells are intentionally borderless in preview mode; their hover toolbar is absolutely positioned. Do not reintroduce layout shifts when editing.

## Coding conventions

- JavaScript: no framework, no modules; everything lives inside the single IIFE. Use `el()`, `$`, `$$`, `icon()`, and existing helpers instead of ad-hoc DOM code.
- Use `textContent` for plain text and `sanitizeHtml()`/`renderMarkdown()` for rich content. Avoid raw `innerHTML` with untrusted values.
- CSS: keep new rules in the relevant grouped section, use existing custom properties, and include a comment only where the reason is non-obvious.
- Python: standard library only, explicit UTF-8 file I/O, preserve the existing JSON line protocol and SSE message shapes.
- Windows/PowerShell is the primary shell here. The console code page may be cp874 and cannot print characters such as `²`; write test output to UTF-8 files or use `ascii()`/`repr()` when debugging.

## Common pitfalls

- Editing only `app.js`: changes vanish on the next rebuild. Edit the parts and rebuild.
- Forgetting to hard reload: CSS/JS changes may appear stale even with `no-cache`.
- Nested scroll containers: `.outputs` and `.out-html` both scroll horizontally. Prefer making the inner element (`.out-html`/`.out-md`) the scroller; avoid adding more wrappers.
- Autosave races: the frontend saves to `localStorage` and to disk shortly after edits. Do not open and rewrite notebook files while a browser session is active unless coordinating with the user.
- Sanitizer restrictions: inline styles are allowed, but `<style>` blocks and scripts are stripped. CSS-variable-based output works; stylesheet injection does not.
- Kernel state: restart the kernel after changing `kernel.py`; existing browser cells keep their state until restart.

## Minimum review checklist

1. `web/js/app.js` rebuilt and in sync with the four parts.
2. No `window.__cobaltErrors` after a hard reload.
3. No horizontal page overflow at 1440 px and 736 px.
4. Long code lines wrap; wide output (table/SVG) scrolls inside the cell.
5. Dark and light themes both look correct.
6. `Shift + Enter`, `Ctrl + Enter`, autosave, and import/export still work for a normal notebook.
