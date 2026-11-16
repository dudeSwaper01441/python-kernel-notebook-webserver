/* ==========================================================================
   Cobalt — notebook application
   ========================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name, className) {
    return '<svg class="icon ' + (className || '') + '"><use href="#i-' + name + '"></use></svg>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function fmtDuration(ms) {
    if (ms == null || Number.isNaN(ms)) return '';
    if (ms < 1) return '<1 ms';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return minutes + 'm ' + seconds + 's';
  }

  function fmtUptime(seconds) {
    if (!seconds) return '—';
    const s = Math.round(seconds);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function timeAgo(timestamp) {
    if (!timestamp) return 'just now';
    const diff = Date.now() - timestamp;
    if (diff < 45000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function slugify(value) {
    return String(value || 'notebook').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'notebook';
  }

  // --------------------------------------------------------------- constants

  const LS_NOTEBOOKS = 'cobalt.notebooks.v2';
  const LS_CURRENT = 'cobalt.current.v2';
  const LS_THEME = 'cobalt.theme';
  const MAX_STREAM_CHARS = 2000000;

  const PY_KEYWORDS = [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
    'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
    'True', 'try', 'while', 'with', 'yield', 'print', 'len', 'range', 'enumerate', 'zip',
    'map', 'filter', 'sum', 'min', 'max', 'sorted', 'reversed', 'list', 'dict', 'set',
    'tuple', 'str', 'int', 'float', 'bool', 'open', 'isinstance', 'type', 'repr', 'format',
    'abs', 'round', 'any', 'all', 'getattr', 'setattr', 'hasattr', 'dir', 'help', 'display',
    'HTML', 'Markdown', 'SVG',
  ];

  // ------------------------------------------------------------------- state

  const state = {
    notebooks: {},
    notebook: null,
    activeCellId: null,
    editors: new Map(),
    nodes: new Map(),
    pending: 0,
    runAllActive: false,
    stopRequested: false,
    queue: Promise.resolve(),
    abort: null,
    kernel: { unknown: true },
    vars: [],
    saveTimer: null,
    serverTimer: null,
    varsTimer: null,
    palette: null,
  };

  // ------------------------------------------------------------ demo notebook

  const md = (...lines) => lines.join('\n');

  const WELCOME_CELLS = [
    {
      type: 'markdown',
      source: md(
        'A Python notebook that runs on your machine. One kernel, real tracebacks, and output streamed straight into the browser.',
        '',
        '- **Shift + Enter** runs a cell and advances',
        '- **Ctrl + K** opens the command palette',
        '- **Ctrl + S** saves the notebook to disk',
        '',
        '> The kernel is a single long-lived CPython process. Variables survive between cells, and nothing leaves this computer.',
      ),
    },
    { type: 'markdown', source: '## Hello, Python' },
    {
      type: 'code',
      source: [
        'import platform, sys',
        '',
        'print("Python", platform.python_version())',
        'print("Executable:", sys.executable)',
        'print("Prefix:", sys.prefix)',
      ].join('\n'),
    },
    {
      type: 'markdown',
      source: md(
        '## One kernel, shared memory',
        '',
        'Cells share one Python process, so anything you define is available everywhere. No re-running imports, no rebuilding state.',
        '',
        'Run the next cell, then add a new one that uses `total`.',
      ),
    },
    {
      type: 'code',
      source: [
        'squares = [n * n for n in range(1, 11)]',
        'total = sum(squares)',
        '',
        'print("squares =", squares)',
        'print("total   =", total)',
        '',
        'total',
      ].join('\n'),
    },
    {
      type: 'markdown',
      source: md(
        '## Output',
        '',
        '`display()` accepts HTML, SVG, Markdown and images. matplotlib figures are captured inline when the library is installed.',
        '',
        'The chart below is generated in Python and rendered in the browser:',
      ),
    },
    {
      type: 'code',
      source: [
        'from math import sqrt',
        '',
        'values = [(n, n * n) for n in range(1, 8)]',
        'peak = max(v for _, v in values)',
        'bars = []',
        '',
        'for i, (n, v) in enumerate(values):',
        '    x, h = 18 + i * 60, round(96 * sqrt(v / peak))',
        '    bars.append(',
        '        f\'<rect x="{x}" y="{132 - h}" width="34" height="{h}" rx="2" style="fill:var(--accent)"/>\'',
        '        f\'<text x="{x + 17}" y="{124 - h}" text-anchor="middle" fill="currentColor" fill-opacity=".8" font-size="11">{v}</text>\'',
        '        f\'<text x="{x + 17}" y="152" text-anchor="middle" fill="currentColor" fill-opacity=".45" font-size="10">{n}²</text>\'',
        '    )',
        '',
        'display(HTML(f"""',
        '<div style="padding:14px 4px 0;font-family:inherit">',
        '  <div style="font-size:12px;color:var(--muted);margin:0 0 10px 12px">n² — computed in Python, drawn in the browser</div>',
        '  <svg viewBox="0 0 440 166" width="100%" style="max-width:440px;overflow:visible">',
        '    <line x1="12" y1="132" x2="430" y2="132" stroke="var(--border-strong)"/>',
        '    {bars}',
        '  </svg>',
        '</div>',
        '"""))',
      ].join('\n'),
    },
    {
      type: 'markdown',
      source: md(
        '## Shortcuts',
        '',
        '| Shortcut | Action |',
        '| --- | --- |',
        '| `Shift + Enter` | Run and advance |',
        '| `Ctrl + Enter` | Run in place |',
        '| `Alt + Enter` | Run and insert below |',
        '| `Ctrl + K` | Command palette |',
        '| `Ctrl + S` | Save to `notebooks/` |',
        '',
        'Shell escapes work too — try `!python --version` in a code cell.',
        '',
        'Everything is autosaved locally, and the download menu exports a real `.ipynb` you can open in Jupyter or Colab.',
      ),
    },
  ];

  // ------------------------------------------------------------- persistence

  function makeCell(type, source) {
    return {
      id: uid(),
      type: type === 'markdown' ? 'markdown' : 'code',
      source: source || '',
      outputs: [],
      execCount: null,
      duration: null,
      status: 'idle',
      error: false,
    };
  }

  function makeNotebook(title, cellDefs) {
    const defs = cellDefs && cellDefs.length ? cellDefs : [{ type: 'code', source: '' }];
    return {
      id: uid(),
      title: title || 'Untitled notebook',
      created: Date.now(),
      updated: Date.now(),
      cells: defs.map((def) => makeCell(def.type, def.source)),
    };
  }

  function welcomeNotebook() {
    const notebook = makeNotebook('Welcome to Cobalt', WELCOME_CELLS);
    notebook.cells.forEach((cell) => {
      cell.execCount = null;
      cell.duration = null;
    });
    return notebook;
  }

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_NOTEBOOKS) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (error) {
      return {};
    }
  }

  function persistStore(store) {
    try {
      localStorage.setItem(LS_NOTEBOOKS, JSON.stringify(store));
      return true;
    } catch (error) {
      return false;
    }
  }

  function serializableNotebook(notebook, dropImages) {
    return {
      id: notebook.id,
      title: notebook.title,
      created: notebook.created,
      updated: Date.now(),
      cells: notebook.cells.map((cell) => ({
        id: cell.id,
        type: cell.type,
        source: cell.source,
        execCount: cell.execCount == null ? null : cell.execCount,
        duration: cell.duration == null ? null : cell.duration,
        outputs: (cell.outputs || []).map((out) => {
          if (out.kind === 'stream') {
            const text = String(out.text || '');
            return { kind: 'stream', name: out.name || 'stdout', text: text.length > 20000 ? text.slice(0, 20000) + '\n…' : text };
          }
          if (out.kind === 'error') {
            return { kind: 'error', ename: out.ename, evalue: out.evalue, traceback: out.traceback || [] };
          }
          if (out.kind === 'result' || out.kind === 'display') {
            const data = Object.assign({}, out.data || {});
            if (dropImages) {
              delete data['image/png'];
              delete data['image/jpeg'];
            } else {
              ['image/png', 'image/jpeg'].forEach((mime) => {
                if (typeof data[mime] === 'string' && data[mime].length > 600000) delete data[mime];
              });
            }
            return { kind: out.kind, data: data };
          }
          return null;
        }).filter(Boolean),
      })),
    };
  }

  function hydrateNotebook(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cells = Array.isArray(raw.cells) ? raw.cells.map((cell) => {
      const hydrated = makeCell(cell.type, typeof cell.source === 'string' ? cell.source : '');
      hydrated.id = cell.id || hydrated.id;
      hydrated.outputs = Array.isArray(cell.outputs)
        ? cell.outputs.filter((out) => out && out.kind).map((out) => Object.assign({}, out))
        : [];
      hydrated.execCount = cell.execCount == null ? null : cell.execCount;
      hydrated.duration = cell.duration == null ? null : cell.duration;
      hydrated.error = hydrated.outputs.some((out) => out.kind === 'error');
      return hydrated;
    }) : [makeCell('code', '')];
    return {
      id: raw.id || uid(),
      title: raw.title || 'Untitled notebook',
      created: raw.created || Date.now(),
      updated: raw.updated || Date.now(),
      cells: cells,
    };
  }

  // ------------------------------------------------------------------ saving

  function setSaveState(mode) {
    const badge = $('#save-state');
    const label = $('#save-label');
    if (!badge || !label) return;
    badge.classList.remove('saving', 'error');
    if (mode === 'saving') {
      badge.classList.add('saving');
      label.textContent = 'Saving…';
    } else if (mode === 'error') {
      badge.classList.add('error');
      label.textContent = 'Not saved';
    } else {
      label.textContent = 'Saved';
    }
  }

  function scheduleSave() {
    setSaveState('saving');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveNow(), 650);
  }

  function saveNow() {
    if (!state.notebook) return;
    state.notebook.updated = Date.now();
    const store = loadStore();
    store[state.notebook.id] = serializableNotebook(state.notebook);
    if (!persistStore(store)) {
      const compact = loadStore();
      compact[state.notebook.id] = serializableNotebook(state.notebook, true);
      if (persistStore(compact)) {
        state.notebooks = compact;
        toast('Notebook is large — images were left out of the local save', { type: 'warn' });
      } else {
        setSaveState('error');
        toast('Could not save locally — browser storage is full', { type: 'error' });
        return;
      }
    } else {
      state.notebooks = store;
    }
    try { localStorage.setItem(LS_CURRENT, state.notebook.id); } catch (error) { /* ignore */ }
    setSaveState('saved');
    renderNotebookList();
    updateMeta();
    scheduleServerSave();
  }

  function scheduleServerSave() {
    clearTimeout(state.serverTimer);
    state.serverTimer = setTimeout(() => {
      if (!state.notebook) return;
      fetch('/api/notebooks/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.notebook.id, ipynb: toIpynb(state.notebook) }),
      }).catch(() => { /* offline is fine — localStorage has it */ });
    }, 1600);
  }

  // ------------------------------------------------------------ notebook list

  function renderNotebookList() {
    const list = $('#nb-list');
    if (!list || !state.notebook) return;
    list.innerHTML = '';
    const items = Object.values(state.notebooks || {})
      .filter((nb) => nb && nb.id)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));

    if (!items.length) {
      list.innerHTML = '<div class="empty-mini">No notebooks yet</div>';
      return;
    }

    items.slice(0, 40).forEach((notebook) => {
      const row = el('div', 'nb-item' + (notebook.id === state.notebook.id ? ' active' : ''));
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.innerHTML =
        '<span class="nb-item-icon">' + icon('book') + '</span>' +
        '<span class="nb-item-text"><span class="nb-item-title"></span><span class="nb-item-meta"></span></span>' +
        '<button class="nb-item-del" title="Delete notebook" aria-label="Delete notebook">' + icon('trash') + '</button>';
      row.querySelector('.nb-item-title').textContent = notebook.title || 'Untitled notebook';
      const count = (notebook.cells || []).length;
      row.querySelector('.nb-item-meta').textContent = count + ' cell' + (count === 1 ? '' : 's') + ' · ' + timeAgo(notebook.updated);
      row.addEventListener('click', (event) => {
        if (event.target.closest('.nb-item-del')) return;
        openNotebook(notebook.id);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openNotebook(notebook.id); }
      });
      row.querySelector('.nb-item-del').addEventListener('click', (event) => {
        event.stopPropagation();
        deleteNotebook(notebook.id);
      });
      list.appendChild(row);
    });
  }

  function openNotebook(id) {
    const store = loadStore();
    const raw = store[id];
    if (!raw) return;
    if (state.notebook) saveNow();
    const notebook = hydrateNotebook(raw);
    if (!notebook) return;
    state.notebook = notebook;
    state.activeCellId = null;
    state.vars = [];
    try { localStorage.setItem(LS_CURRENT, id); } catch (error) { /* ignore */ }
    renderNotebook();
    renderNotebookList();
    renderVars({ items: [], busy: false });
    updateMeta();
    setSaveState('saved');
    $('#main').scrollTop = 0;
    if (window.innerWidth <= 860) $('.app').classList.remove('sidebar-open');
  }

  function newNotebook(title, cellDefs) {
    if (state.notebook) saveNow();
    const notebook = makeNotebook(title || 'Untitled notebook', cellDefs);
    const store = loadStore();
    store[notebook.id] = serializableNotebook(notebook);
    persistStore(store);
    try { localStorage.setItem(LS_CURRENT, notebook.id); } catch (error) { /* ignore */ }
    state.notebooks = store;
    state.notebook = notebook;
    state.activeCellId = notebook.cells[0] ? notebook.cells[0].id : null;
    state.vars = [];
    renderNotebook();
    renderNotebookList();
    renderVars({ items: [], busy: false });
    setSaveState('saved');
    $('#main').scrollTop = 0;
    setTimeout(() => focusCell(notebook.cells[0]), 40);
    return notebook;
  }

  function deleteNotebook(id) {
    const notebook = state.notebooks[id];
    if (!notebook) return;
    const store = loadStore();
    delete store[id];
    persistStore(store);
    state.notebooks = store;

    if (state.notebook && state.notebook.id === id) {
      const remaining = Object.values(store).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      if (remaining.length) openNotebook(remaining[0].id);
      else newNotebook('Untitled notebook');
    } else {
      renderNotebookList();
    }

    toast('Deleted “' + (notebook.title || 'notebook') + '”', {
      type: 'info',
      action: {
        label: 'Undo',
        run: () => {
          const restored = loadStore();
          restored[id] = notebook;
          persistStore(restored);
          state.notebooks = restored;
          openNotebook(id);
        },
      },
    });
  }

  function duplicateNotebook() {
    if (!state.notebook) return;
    saveNow();
    const source = hydrateNotebook(JSON.parse(JSON.stringify(serializableNotebook(state.notebook))));
    source.id = uid();
    source.title = state.notebook.title + ' (copy)';
    source.created = Date.now();
    source.updated = Date.now();
    source.cells.forEach((cell) => { cell.id = uid(); cell.status = 'idle'; });
    const store = loadStore();
    store[source.id] = serializableNotebook(source);
    persistStore(store);
    state.notebooks = store;
    state.notebook = source;
    state.activeCellId = source.cells[0] ? source.cells[0].id : null;
    try { localStorage.setItem(LS_CURRENT, source.id); } catch (error) { /* ignore */ }
    renderNotebook();
    renderNotebookList();
    updateMeta();
    toast('Notebook duplicated', { type: 'success' });
  }

  function updateMeta() {
    if (!state.notebook) return;
    const count = state.notebook.cells.length;
    const metaCells = $('#meta-cells');
    if (metaCells) metaCells.textContent = count + ' cell' + (count === 1 ? '' : 's');
    const metaKernel = $('#meta-kernel');
    if (metaKernel) metaKernel.textContent = state.kernel.python ? 'Python ' + state.kernel.python : 'Python';
    const crumb = $('#crumb-title');
    if (crumb) crumb.textContent = state.notebook.title || 'Untitled notebook';
    const title = $('#nb-title');
    if (title && title.value !== state.notebook.title) title.value = state.notebook.title || '';
    document.title = (state.notebook.title || 'Untitled notebook') + ' · Cobalt';
  }
