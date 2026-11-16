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

  // ---------------------------------------------------------------- rendering

  function renderNotebook() {
    state.editors.forEach((cm) => {
      try { cm.getWrapperElement().remove(); } catch (error) { /* ignore */ }
    });
    state.editors.clear();
    state.nodes.clear();
    const cellsEl = $('#cells');
    cellsEl.innerHTML = '';
    if (state.notebook) {
      state.notebook.cells.forEach((cell) => {
        // A full render replaces every editor, so no cell can still be in
        // edit mode. Reset the flag or a restored cell could get stuck.
        cell._editing = false;
        if (cell._formTimer) {
          clearTimeout(cell._formTimer);
          cell._formTimer = null;
        }
        const node = createCellNode(cell);
        cellsEl.appendChild(node.root);
        cellsEl.appendChild(createInsertRow());
      });
    }
    refreshEmptyState();
    updateMeta();
    const active = state.notebook
      ? (state.notebook.cells.find((cell) => cell.id === state.activeCellId) || state.notebook.cells[0])
      : null;
    if (active) setActive(active.id);
    const title = $('#nb-title');
    if (title && state.notebook) title.value = state.notebook.title || '';
  }

  function createCellNode(cell) {
    const root = el('div', 'cell ' + cell.type);
    root.dataset.id = cell.id;
    root.innerHTML =
      '<div class="cell-gutter">' +
        (cell.type === 'code'
          ? '<button class="run-btn" title="Run cell (Shift + Enter)">' + icon('play') + '</button>'
          : '') +
        '<span class="exec-count">[ ]</span>' +
      '</div>' +
      '<div class="cell-body">' +
        '<div class="cell-toolbar">' +
          '<button class="type-chip" title="Change cell type">' + (cell.type === 'code' ? 'Code' : 'Text') + ' ' + icon('chevron-down') + '</button>' +
          '<span class="toolbar-sep"></span>' +
          (cell.type === 'markdown' ? '<button class="tool-btn" data-act="edit" title="Edit text">' + icon('edit') + '</button>' : '') +
          '<button class="tool-btn" data-act="up" title="Move up">' + icon('chevron-up') + '</button>' +
          '<button class="tool-btn" data-act="down" title="Move down">' + icon('chevron-down') + '</button>' +
          '<button class="tool-btn" data-act="add" title="Add cell below">' + icon('plus') + '</button>' +
          '<button class="tool-btn danger" data-act="delete" title="Delete cell">' + icon('trash') + '</button>' +
        '</div>' +
        '<div class="editor-wrap">' +
          (cell.type === 'markdown'
            ? '<div class="md-format-bar" hidden>' +
                '<button class="md-format-btn" type="button" data-format="bold" title="Bold" aria-label="Bold">' + icon('bold') + '</button>' +
                '<button class="md-format-btn" type="button" data-format="italic" title="Italic" aria-label="Italic">' + icon('italic') + '</button>' +
                '<button class="md-format-btn" type="button" data-format="code" title="Inline code" aria-label="Inline code">' + icon('code') + '</button>' +
                '<button class="md-format-btn" type="button" data-format="link" title="Link" aria-label="Insert link">' + icon('link') + '</button>' +
                '<span class="md-format-sep"></span>' +
                '<button class="md-format-btn" type="button" data-format="list" title="Bullet list" aria-label="Bullet list">' + icon('list') + '</button>' +
                '<button class="md-format-btn" type="button" data-format="quote" title="Quote" aria-label="Quote">' + icon('quote') + '</button>' +
              '</div>'
            : '') +
          '<div class="cell-form" hidden></div>' +
          '<div class="cm-host"></div>' +
          '<div class="md-hint" hidden>' + icon('text') + ' Markdown · click outside or <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to preview</div>' +
          '<div class="md-preview" tabindex="0" role="textbox" aria-multiline="true" aria-readonly="true" aria-label="Markdown cell. Press Enter to edit."></div>' +
        '</div>' +
        '<div class="outputs"></div>' +
        '<div class="cell-foot"></div>' +
      '</div>';

    const node = {
      root: root,
      cell: cell,
      body: $('.cell-body', root),
      outputsEl: $('.outputs', root),
      footEl: $('.cell-foot', root),
      countEl: $('.exec-count', root),
      runBtn: $('.run-btn', root),
      hostEl: $('.cm-host', root),
      formEl: $('.cell-form', root),
      previewEl: $('.md-preview', root),
      hintEl: $('.md-hint', root),
      formatBar: $('.md-format-bar', root),
      editBtn: $('[data-act="edit"]', root),
    };
    state.nodes.set(cell.id, node);

    root.addEventListener('pointerdown', () => setActive(cell.id));

    if (node.runBtn) {
      node.runBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setActive(cell.id);
        if (cell.status === 'running') stopExecution();
        else runCellNow(cell);
      });
    }

    // The form replaces the editor visually, so keep the usual run shortcut
    // available from inside its fields.
    node.formEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      runCellNow(cell);
    });

    node.previewEl.addEventListener('dblclick', () => enterMarkdownEdit(cell));
    node.previewEl.addEventListener('click', () => {
      // An empty text cell has nothing to focus, so a single click starts
      // editing instead of making the user double-click the placeholder.
      if (!cell.source.trim()) enterMarkdownEdit(cell);
    });
    node.previewEl.addEventListener('keydown', (event) => {
      // Only activate from the preview itself, not from a link or checkbox
      // inside the rendered content.
      if (event.target !== node.previewEl) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        enterMarkdownEdit(cell);
      }
    });

    $$('.tool-btn', node.body).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const action = button.dataset.act;
        if (action === 'up') moveCell(cell, -1);
        else if (action === 'down') moveCell(cell, 1);
        else if (action === 'add') addCellAt(indexOfCell(cell.id) + 1, 'code', true);
        else if (action === 'delete') deleteCell(cell);
        else if (action === 'edit') {
          if (cell._editing) exitMarkdownEdit(cell);
          else enterMarkdownEdit(cell);
        }
      });
    });

    if (node.formatBar) {
      $$('.md-format-btn', node.formatBar).forEach((button) => {
        // Keep the CodeMirror selection while the button is pressed.
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          applyMarkdownFormat(state.editors.get(cell.id), button.dataset.format);
        });
      });
    }

    const typeChip = $('.type-chip', node.body);
    typeChip.addEventListener('click', (event) => {
      event.stopPropagation();
      openTypeMenu(cell, typeChip);
    });

    if (cell.type === 'code') {
      node.previewEl.style.display = 'none';
      node.hintEl.hidden = true;
      mountCodeEditor(cell, node.hostEl, 'python');
      refreshCellForm(cell, { initial: true });
    } else {
      node.hostEl.style.display = 'none';
      renderMarkdownPreview(cell);
    }

    renderOutputs(cell);
    renderCellChrome(cell);
    return node;
  }

  function mountCodeEditor(cell, host, mode) {
    host.innerHTML = '';
    const isPython = mode === 'python';
    const cm = CodeMirror(host, {
      value: cell.source,
      mode: mode,
      theme: 'cobalt',
      lineNumbers: isPython,
      lineWrapping: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      smartIndent: true,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
      viewportMargin: Infinity,
      placeholder: isPython ? '# Write Python — Shift + Enter to run' : 'Write Markdown…',
      hintOptions: { completeSingle: false },
      extraKeys: isPython ? {
        'Shift-Enter': () => runAndAdvance(cell),
        'Ctrl-Enter': () => runCellNow(cell),
        'Cmd-Enter': () => runCellNow(cell),
        'Alt-Enter': () => runAndInsert(cell),
        'Ctrl-/': 'toggleComment',
        'Cmd-/': 'toggleComment',
        'Ctrl-Space': (instance) => instance.showHint({ hint: pythonHint, completeSingle: false }),
        'Tab': (instance) => {
          if (instance.somethingSelected()) instance.indentSelection('add');
          else instance.replaceSelection('    ', 'end');
        },
        'Shift-Tab': (instance) => instance.indentSelection('subtract'),
        'Esc': (instance) => { instance.getInputField().blur(); setActive(cell.id); },
      } : {
        'Shift-Enter': () => { exitMarkdownEdit(cell); focusNext(cell); },
        'Ctrl-Enter': () => exitMarkdownEdit(cell),
        'Cmd-Enter': () => exitMarkdownEdit(cell),
        'Alt-Enter': () => { exitMarkdownEdit(cell); addCellAt(indexOfCell(cell.id) + 1, 'code', true); },
        'Esc': () => exitMarkdownEdit(cell),
        'Tab': (instance) => {
          if (instance.somethingSelected()) instance.indentSelection('add');
          else instance.replaceSelection('    ', 'end');
        },
      },
    });

    cm.on('change', (instance, change) => {
      cell.source = cm.getValue();
      sizeEditor(cm);
      scheduleSave();
      // Form edits already update the panel in place. Any other source change
      // may add, remove, or reorder parameters, so rebuild after typing stops.
      if (!change || change.origin !== 'cobalt-form') scheduleFormRefresh(cell);
    });
    cm.on('focus', () => setActive(cell.id));

    state.editors.set(cell.id, cm);
    sizeEditor(cm);
    setTimeout(() => { try { cm.refresh(); sizeEditor(cm); } catch (error) { /* ignore */ } }, 30);
    return cm;
  }

  function sizeEditor(cm) {
    if (!cm) return;
    const wrapper = cm.getWrapperElement();
    if (!wrapper || !wrapper.isConnected) return;
    const height = Math.max(44, cm.getDoc().height + 26);
    cm.setSize(null, height);
  }

  const sizeAllEditors = debounce(() => {
    state.editors.forEach((cm) => {
      try { cm.refresh(); sizeEditor(cm); } catch (error) { /* ignore */ }
    });
  }, 120);

  // --------------------------------------------------------------- cell forms
  //
  // Colab-style parameter forms live entirely in comments:
  //
  //   #@title Student
  //   name = "Ada" #@param {type:"string"}
  //   room = 8 #@param {type:"integer"}
  //
  // The source stays the single source of truth. Form controls replace only
  // the literal on their own line, so execution, autosave, and .ipynb export
  // keep working without a second value store.

  function parseCellForm(source) {
    const form = { title: '', items: [], params: [] };
    const lines = String(source == null ? '' : source).split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const titleMatch = /^\s*#\s*@title\b\s*(.*)$/.exec(line);
      if (titleMatch) {
        if (!form.title) form.title = titleMatch[1].trim();
        continue;
      }
      const noteMatch = /^\s*#\s*@markdown\b\s?(.*)$/.exec(line);
      if (noteMatch) {
        form.items.push({ kind: 'note', text: noteMatch[1], line: index });
        continue;
      }
      if (/#\s*@param\b/.test(line)) {
        const param = parseParamLine(line, index);
        if (param) {
          form.items.push(param);
          form.params.push(param);
        }
      }
    }
    return form;
  }

  function parseParamLine(line, lineIndex) {
    const marker = /#\s*@param\b/.exec(line);
    if (!marker) return null;
    const code = line.slice(0, marker.index).replace(/\s+$/, '');
    const equal = code.indexOf('=');
    if (equal < 0) return null;
    const name = code.slice(0, equal).trim();
    if (!name) return null;
    const rawValue = code.slice(equal + 1);
    const valueText = rawValue.trim();
    if (!valueText) return null;
    const valueStart = equal + 1 + (rawValue.length - rawValue.trimStart().length);
    const valueEnd = valueStart + valueText.length;
    const spec = line.slice(marker.index + marker[0].length);
    const options = parseParamOptions(spec);
    const config = parseParamConfig(spec);
    const type = normalizeParamType(config.type, options, valueText);
    const step = config.step == null ? 1 : numberOr(config.step, 1);
    return {
      kind: 'param',
      line: lineIndex,
      name: name,
      label: typeof config.label === 'string' && config.label ? config.label : name,
      type: type,
      value: paramValueFromLiteral(valueText, type),
      literal: valueText,
      literalStart: valueStart,
      literalEnd: valueEnd,
      min: config.min == null ? null : numberOr(config.min, 0),
      max: config.max == null ? null : numberOr(config.max, 10),
      step: step > 0 ? step : 1,
      options: options,
    };
  }

  function normalizeParamType(type, options, literal) {
    const value = typeof type === 'string' ? type.toLowerCase() : '';
    const aliases = { int: 'integer', float: 'number', bool: 'boolean', enum: 'string', dropdown: 'string' };
    const normalized = aliases[value] || value;
    if (normalized === 'string' || normalized === 'integer' || normalized === 'number' ||
        normalized === 'boolean' || normalized === 'slider' || normalized === 'date' ||
        normalized === 'raw') {
      return normalized;
    }
    if (options && options.length) return 'string';
    const text = String(literal == null ? '' : literal).trim();
    if (/^(True|False)$/.test(text)) return 'boolean';
    if (/^[-+]?\d+$/.test(text)) return 'integer';
    if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+[eE][-+]?\d+|\d+\.\d*[eE][-+]?\d+)$/.test(text)) return 'number';
    return 'string';
  }

  function parseParamOptions(text) {
    const match = /^\s*\[([\s\S]*?)\]/.exec(String(text || ''));
    if (!match) return [];
    const body = match[1].trim();
    if (!body) return [];
    return splitParamList(body).map(parseParamOption).filter(Boolean);
  }

  function splitParamList(body) {
    const parts = [];
    let current = '';
    let quote = '';
    let depth = 0;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (quote) {
        current += ch;
        if (ch === '\\') {
          if (i + 1 < body.length) {
            current += body[i + 1];
            i += 1;
          }
        } else if (ch === quote) {
          quote = '';
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '[' || ch === '(' || ch === '{') {
        depth += 1;
        current += ch;
      } else if (ch === ']' || ch === ')' || ch === '}') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current);
    return parts;
  }

  function parseParamOption(token) {
    const text = String(token || '').trim();
    if (!text) return null;
    if (/^['"]/.test(text)) {
      const value = parsePyString(text);
      return { value: value, label: value, literal: pyStringLiteral(value) };
    }
    if (/^(True|False)$/.test(text)) {
      return { value: text === 'True', label: text, literal: text };
    }
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
      return { value: Number(text), label: text, literal: text };
    }
    return { value: text, label: text, literal: pyStringLiteral(text) };
  }

  function parseParamConfig(text) {
    const config = {};
    const match = /\{([\s\S]*?)\}/.exec(String(text || ''));
    if (!match) return config;
    const pair = /([A-Za-z_]\w*)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|true|false|null)/g;
    let item = null;
    while ((item = pair.exec(match[1]))) {
      const key = item[1];
      const raw = item[2];
      if (raw[0] === '"' || raw[0] === "'") config[key] = parsePyString(raw);
      else if (raw === 'true') config[key] = true;
      else if (raw === 'false') config[key] = false;
      else if (raw === 'null') config[key] = null;
      else config[key] = Number(raw);
    }
    return config;
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function paramValueFromLiteral(literal, type) {
    const text = String(literal == null ? '' : literal).trim();
    if (type === 'boolean') return text === 'True';
    if (type === 'integer') {
      const number = Number(text);
      return Number.isFinite(number) ? Math.trunc(number) : 0;
    }
    if (type === 'number' || type === 'slider') {
      const number = Number(text);
      return Number.isFinite(number) ? number : 0;
    }
    if (type === 'raw') return text;
    return parsePyString(text);
  }

  function parsePyString(literal) {
    const text = String(literal == null ? '' : literal).trim();
    let start = 0;
    while (start < text.length && /[rRbBuUfF]/.test(text[start])) start += 1;
    const rawPrefix = /[rR]/.test(text.slice(0, start));
    const quoted = text.slice(start);
    let body = null;
    if (quoted.length >= 6 &&
        (quoted.slice(0, 3) === '"""' || quoted.slice(0, 3) === "'''") &&
        quoted.slice(-3) === quoted.slice(0, 3)) {
      body = quoted.slice(3, -3);
    } else if (quoted.length >= 2 &&
               (quoted[0] === '"' || quoted[0] === "'") &&
               quoted[quoted.length - 1] === quoted[0]) {
      body = quoted.slice(1, -1);
    }
    if (body == null) return text;
    return rawPrefix ? body : unescapePyString(body);
  }

  function unescapePyString(body) {
    let out = '';
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      i += 1;
      if (i >= body.length) break;
      const esc = body[i];
      if (esc === '\n') continue;
      if (esc === '\r') {
        if (body[i + 1] === '\n') i += 1;
        continue;
      }
      if (esc === 'n') out += '\n';
      else if (esc === 't') out += '\t';
      else if (esc === 'r') out += '\r';
      else if (esc === 'b') out += '\b';
      else if (esc === 'f') out += '\f';
      else if (esc === 'v') out += '\v';
      else if (esc === '0') out += '\0';
      else if (esc === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 1, i + 3))) {
        out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
        i += 4;
      } else if (esc === 'U' && /^[0-9a-fA-F]{8}$/.test(body.slice(i + 1, i + 9))) {
        const code = parseInt(body.slice(i + 1, i + 9), 16);
        if (code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)) out += String.fromCodePoint(code);
        i += 8;
      } else {
        out += esc;
      }
    }
    return out;
  }

  function pyStringLiteral(value) {
    return JSON.stringify(String(value == null ? '' : value))
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  function formatParamNumber(value, param) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return param.type === 'integer' ? String(Math.trunc(number)) : String(number);
  }

  function paramLiteralFromInput(param, raw) {
    const value = String(raw == null ? '' : raw);
    if (param.type === 'raw') {
      const text = value.trim();
      return text || null;
    }
    if (param.type === 'integer' || param.type === 'number' || param.type === 'slider') {
      if (!value.trim()) return null;
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      return param.type === 'integer' ? String(Math.trunc(number)) : String(number);
    }
    return pyStringLiteral(value);
  }

  function refreshCellForm(cell, options) {
    const node = state.nodes.get(cell.id);
    if (!node || !node.formEl) return;
    if (cell._formTimer) {
      clearTimeout(cell._formTimer);
      cell._formTimer = null;
    }
    const spec = parseCellForm(cell.source);
    if (!spec.params.length) {
      cell._formSpec = null;
      cell._formCodeVisible = true;
      node.formEl.hidden = true;
      node.formEl.innerHTML = '';
      node.hostEl.style.display = '';
      node.root.classList.remove('form-code-hidden');
      return;
    }
    if (options && options.initial) {
      // Colab hides the source once a cell becomes a form. If the user just
      // typed the parameters into an open editor, leave the code visible.
      cell._formCodeVisible = false;
    } else if (cell._formCodeVisible == null) {
      cell._formCodeVisible = true;
    }
    cell._formSpec = spec;
    buildCellForm(cell, spec);
    updateFormCodeVisibility(cell);
  }

  function scheduleFormRefresh(cell) {
    clearTimeout(cell._formTimer);
    cell._formTimer = setTimeout(() => {
      cell._formTimer = null;
      if (state.nodes.has(cell.id)) refreshCellForm(cell);
    }, 220);
  }

  function buildCellForm(cell, spec) {
    const node = state.nodes.get(cell.id);
    if (!node) return;
    const panel = node.formEl;
    panel.hidden = false;
    panel.innerHTML = '';
    panel.classList.toggle('form-has-title', !!spec.title);
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', spec.title || 'Cell parameters');
    const inner = el('div', 'form-inner');
    if (spec.title) inner.appendChild(el('div', 'form-title', spec.title));
    const fields = el('div', 'form-fields');
    spec.items.forEach((item) => {
      if (item.kind === 'note') {
        const note = el('div', 'form-note');
        note.innerHTML = renderMarkdown(item.text);
        $$('a[href]', note).forEach((link) => {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        });
        fields.appendChild(note);
      } else {
        fields.appendChild(buildFormField(cell, item));
      }
    });
    inner.appendChild(fields);
    const actions = el('div', 'form-actions');
    const toggle = el('button', 'form-code-toggle');
    toggle.type = 'button';
    toggle.dataset.formToggle = 'code';
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      cell._formCodeVisible = cell._formCodeVisible === false;
      updateFormCodeVisibility(cell);
    });
    actions.appendChild(toggle);
    inner.appendChild(actions);
    panel.appendChild(inner);
  }

  function buildFormField(cell, param) {
    const field = el('div', 'form-field');
    const inputId = 'cobalt-form-' + cell.id + '-' + param.line;
    const label = el('label', 'form-label', param.label);
    label.htmlFor = inputId;
    label.title = param.name;
    field.appendChild(label);
    const control = el('div', 'form-control');
    let input = null;

    if (param.type === 'boolean') {
      input = el('input', 'form-checkbox');
      input.type = 'checkbox';
      input.id = inputId;
      input.checked = !!param.value;
      const stateLabel = el('span', 'form-bool-text', input.checked ? 'True' : 'False');
      input.addEventListener('change', () => {
        if (applyFormLiteral(cell, param, input.checked ? 'True' : 'False')) {
          stateLabel.textContent = input.checked ? 'True' : 'False';
        }
      });
      control.appendChild(input);
      control.appendChild(stateLabel);
    } else if (param.type === 'slider') {
      input = el('input', 'form-slider');
      input.type = 'range';
      input.id = inputId;
      let min = Number.isFinite(param.min) ? param.min : 0;
      let max = Number.isFinite(param.max) ? param.max : 10;
      const value = Number(param.value);
      if (Number.isFinite(value)) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (max <= min) max = min + param.step;
      input.min = String(min);
      input.max = String(max);
      input.step = String(param.step);
      input.value = String(clamp(Number.isFinite(value) ? value : min, min, max));
      const output = el('output', 'form-slider-value', formatParamNumber(input.value, param));
      output.setAttribute('for', inputId);
      input.addEventListener('input', () => {
        output.textContent = formatParamNumber(input.value, param);
        applyFormLiteral(cell, param, formatParamNumber(input.value, param));
      });
      control.appendChild(input);
      control.appendChild(output);
    } else if (param.type === 'date') {
      input = el('input', 'form-input');
      input.type = 'date';
      input.id = inputId;
      input.value = /^\d{4}-\d{2}-\d{2}$/.test(String(param.value)) ? param.value : '';
      input.addEventListener('change', () => {
        applyFormLiteral(cell, param, pyStringLiteral(input.value));
      });
      control.appendChild(input);
    } else if (param.options && param.options.length) {
      const wrap = el('div', 'form-select-wrap');
      input = el('select', 'form-select');
      input.id = inputId;
      const matches = (option) => param.type === 'string'
        ? String(option.value).toLowerCase() === String(param.value).toLowerCase()
        : String(option.value) === String(param.value);
      if (!param.options.some(matches) && String(param.value)) {
        const extra = el('option', null, String(param.value));
        extra.value = String(param.value);
        input.appendChild(extra);
      }
      param.options.forEach((option) => {
        const item = el('option', null, option.label);
        item.value = String(option.value);
        item.selected = matches(option);
        input.appendChild(item);
      });
      input.addEventListener('change', () => {
        const selected = param.options.find((option) => String(option.value) === input.value);
        if (selected) applyFormLiteral(cell, param, selected.literal);
        else applyFormLiteral(cell, param, paramLiteralFromInput(param, input.value));
      });
      wrap.appendChild(input);
      wrap.insertAdjacentHTML('beforeend', icon('chevron-down'));
      control.appendChild(wrap);
    } else {
      input = el('input', param.type === 'raw' ? 'form-input form-mono' : 'form-input');
      input.type = param.type === 'integer' || param.type === 'number' ? 'number' : 'text';
      input.id = inputId;
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (param.type === 'integer') input.step = '1';
      else if (param.type === 'number') input.step = 'any';
      if ((param.type === 'integer' || param.type === 'number') && Number.isFinite(param.min)) input.min = String(param.min);
      if ((param.type === 'integer' || param.type === 'number') && Number.isFinite(param.max)) input.max = String(param.max);
      input.value = param.type === 'raw' ? param.literal : String(param.value == null ? '' : param.value);
      input.addEventListener('change', () => {
        const literal = paramLiteralFromInput(param, input.value);
        if (literal == null) {
          input.value = param.type === 'raw' ? param.literal : String(param.value == null ? '' : param.value);
          return;
        }
        applyFormLiteral(cell, param, literal);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        }
      });
      control.appendChild(input);
    }

    field.appendChild(control);
    return field;
  }

  function applyFormLiteral(cell, param, literal) {
    const cm = state.editors.get(cell.id);
    if (!cm || literal == null) return false;
    // Re-parse so the replacement follows edits that have not reached the
    // debounced form refresh yet.
    const spec = parseCellForm(cm.getValue());
    let target = null;
    for (let i = 0; i < spec.params.length; i += 1) {
      if (spec.params[i].line === param.line && spec.params[i].name === param.name) {
        target = spec.params[i];
        break;
      }
    }
    if (!target) target = spec.params.find((item) => item.name === param.name) || null;
    if (!target) return false;
    const lineText = cm.getLine(target.line);
    if (lineText == null || lineText.slice(target.literalStart, target.literalEnd) !== target.literal) {
      scheduleFormRefresh(cell);
      return false;
    }
    cm.replaceRange(
      literal,
      { line: target.line, ch: target.literalStart },
      { line: target.line, ch: target.literalEnd },
      'cobalt-form'
    );
    param.line = target.line;
    param.literal = literal;
    param.literalStart = target.literalStart;
    param.literalEnd = target.literalStart + literal.length;
    param.value = paramValueFromLiteral(literal, param.type);
    return true;
  }

  function updateFormCodeVisibility(cell) {
    const node = state.nodes.get(cell.id);
    if (!node) return;
    const hasForm = !!cell._formSpec && !node.formEl.hidden;
    const showCode = !hasForm || cell._formCodeVisible !== false;
    const cm = state.editors.get(cell.id);
    node.hostEl.style.display = showCode ? '' : 'none';
    node.root.classList.toggle('form-code-hidden', hasForm && !showCode);
    const toggle = $('[data-form-toggle="code"]', node.formEl);
    if (toggle) {
      toggle.innerHTML = icon('code') + '<span>' + (showCode ? 'Hide code' : 'Show code') + '</span>';
      toggle.title = showCode ? 'Hide the source for this cell' : 'Show the source for this cell';
      toggle.setAttribute('aria-expanded', showCode ? 'true' : 'false');
    }
    if (showCode && cm) {
      try {
        cm.refresh();
        sizeEditor(cm);
      } catch (error) { /* ignore */ }
    }
  }

  function renderMarkdownPreview(cell) {
    const node = state.nodes.get(cell.id);
    if (!node) return;
    const source = cell.source || '';
    if (!source.trim()) {
      node.previewEl.innerHTML = '<div class="md-empty">Click to write Markdown…</div>';
      return;
    }
    node.previewEl.innerHTML = '<div class="prose">' + renderMarkdown(source) + '</div>';
    decorateMarkdown(node.previewEl);
  }

  function decorateMarkdown(previewEl) {
    // Wide tables scroll inside the text cell instead of stretching the page.
    $$('.prose table', previewEl).forEach((table) => {
      const wrap = el('div', 'table-scroll');
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
    // Links should never replace the notebook tab.
    $$('.prose a[href]', previewEl).forEach((link) => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
    // Fenced code blocks get syntax colors and a copy button. Only labelled
    // fences are highlighted so plain text is not guessed at.
    $$('.prose pre', previewEl).forEach((pre) => {
      const code = $('code', pre);
      const hasLanguage = code && Array.from(code.classList).some((name) => name.indexOf('language-') === 0);
      if (hasLanguage && window.hljs) {
        try { window.hljs.highlightElement(code); } catch (error) { /* ignore */ }
      }
      const wrap = el('div', 'code-block');
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const copy = el('button', 'code-copy');
      copy.type = 'button';
      copy.title = 'Copy code';
      copy.setAttribute('aria-label', 'Copy code');
      copy.innerHTML = icon('copy');
      copy.addEventListener('click', () => copyCodeBlock(pre, copy));
      wrap.appendChild(copy);
    });
  }

  function copyCodeBlock(pre, button) {
    const text = pre ? pre.textContent : '';
    const done = () => {
      button.innerHTML = icon('check');
      button.title = 'Copied';
      button.classList.add('copied');
      setTimeout(() => {
        if (!button.isConnected) return;
        button.innerHTML = icon('copy');
        button.title = 'Copy code';
        button.classList.remove('copied');
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const textarea = el('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
    textarea.remove();
    if (copied) done();
    else toast('Could not copy code', { type: 'warn' });
  }

  function enterMarkdownEdit(cell) {
    if (!cell || cell.type !== 'markdown') return;
    const node = state.nodes.get(cell.id);
    if (!node || cell._editing) return;
    cell._editing = true;
    node.root.classList.add('editing');
    node.previewEl.style.display = 'none';
    node.hostEl.style.display = '';
    node.hintEl.hidden = false;
    if (node.formatBar) node.formatBar.hidden = false;
    if (node.editBtn) {
      node.editBtn.innerHTML = icon('check');
      node.editBtn.title = 'Preview (click outside or Ctrl + Enter)';
    }
    const cm = mountCodeEditor(cell, node.hostEl, 'markdown');
    setActive(cell.id);
    cm.focus();
    sizeEditor(cm);
    setTimeout(() => { try { cm.refresh(); sizeEditor(cm); } catch (error) { /* ignore */ } }, 30);
  }

  function exitMarkdownEdit(cell) {
    if (!cell || !cell._editing) return;
    const node = state.nodes.get(cell.id);
    const cm = state.editors.get(cell.id);
    if (cm) {
      cell.source = cm.getValue();
      try { cm.getWrapperElement().remove(); } catch (error) { /* ignore */ }
      state.editors.delete(cell.id);
    }
    cell._editing = false;
    if (!node) return;
    node.root.classList.remove('editing');
    node.hostEl.innerHTML = '';
    node.hostEl.style.display = 'none';
    node.hintEl.hidden = true;
    if (node.formatBar) node.formatBar.hidden = true;
    node.previewEl.style.display = '';
    if (node.editBtn) {
      node.editBtn.innerHTML = icon('edit');
      node.editBtn.title = 'Edit text';
    }
    renderMarkdownPreview(cell);
    scheduleSave();
  }

  // A click anywhere outside an editing Markdown cell commits the source and
  // returns it to the rendered preview. Clicks inside the cell, including its
  // toolbar and format bar, are ignored.
  document.addEventListener('pointerdown', (event) => {
    if (!state.notebook) return;
    const cellNode = event.target && event.target.closest ? event.target.closest('.cell') : null;
    const targetId = cellNode ? cellNode.dataset.id : null;
    state.notebook.cells.forEach((cell) => {
      if (cell._editing && cell.id !== targetId) exitMarkdownEdit(cell);
    });
  }, true);

  function applyMarkdownFormat(cm, format) {
    if (!cm) return;
    if (format === 'bold') surroundSelection(cm, '**', '**', 'bold text');
    else if (format === 'italic') surroundSelection(cm, '*', '*', 'italic text');
    else if (format === 'code') surroundSelection(cm, '`', '`', 'code');
    else if (format === 'link') insertMarkdownLink(cm);
    else if (format === 'list') prefixSelectedLines(cm, '- ');
    else if (format === 'quote') prefixSelectedLines(cm, '> ');
    cm.focus();
  }

  function surroundSelection(cm, before, after, placeholder) {
    const from = cm.getCursor('from');
    const selected = cm.getSelection();
    const text = selected || placeholder || '';
    cm.replaceSelection(before + text + after);
    if (!selected && placeholder) {
      // Select the placeholder so typing replaces it immediately.
      const start = { line: from.line, ch: from.ch + before.length };
      cm.setSelection(start, { line: start.line, ch: start.ch + placeholder.length });
    }
  }

  function insertMarkdownLink(cm) {
    const from = cm.getCursor('from');
    const selected = cm.getSelection();
    const text = selected || 'text';
    cm.replaceSelection('[' + text + '](url)');
    if (text.indexOf('\n') === -1) {
      // Select the url placeholder so typing replaces it immediately.
      const start = { line: from.line, ch: from.ch + text.length + 3 };
      cm.setSelection(start, { line: start.line, ch: start.ch + 3 });
    }
  }

  function prefixSelectedLines(cm, prefix) {
    const ranges = cm.listSelections();
    cm.operation(() => {
      ranges.forEach((range) => {
        const from = range.from();
        const to = range.to();
        const startLine = Math.min(from.line, to.line);
        let endLine = Math.max(from.line, to.line);
        // A selection that stops at the start of a line does not include it.
        if (endLine > startLine && to.ch === 0) endLine -= 1;
        for (let line = startLine; line <= endLine; line += 1) {
          if (!cm.getLine(line).startsWith(prefix)) cm.replaceRange(prefix, { line: line, ch: 0 });
        }
      });
    });
  }

  function setActive(id) {
    state.activeCellId = id;
    state.nodes.forEach((node, key) => {
      node.root.classList.toggle('active', key === id);
    });
  }

  function indexOfCell(id) {
    return state.notebook ? state.notebook.cells.findIndex((cell) => cell.id === id) : -1;
  }

  function focusCell(cell, options) {
    if (!cell) return;
    setActive(cell.id);
    if (!options || options.scroll !== false) scrollCellIntoView(cell, options);
    if (cell.type === 'code') {
      const node = state.nodes.get(cell.id);
      if (node && cell._formSpec && cell._formCodeVisible === false) {
        const firstField = $('.form-control input, .form-control select', node.formEl);
        if (firstField) {
          firstField.focus();
          return;
        }
      }
      const cm = state.editors.get(cell.id);
      if (cm) cm.focus();
    } else {
      enterMarkdownEdit(cell);
    }
  }

  function focusNext(cell) {
    const index = indexOfCell(cell.id);
    const next = state.notebook.cells[index + 1];
    if (next) {
      setActive(next.id);
      scrollCellIntoView(next);
      if (next.type === 'code') setTimeout(() => focusCell(next, { scroll: false }), 10);
    } else {
      const created = addCellAt(state.notebook.cells.length, 'code', false);
      focusCell(created);
    }
  }

  function scrollCellIntoView(cell, options) {
    const node = state.nodes.get(cell.id);
    if (!node) return;
    const rect = node.root.getBoundingClientRect();
    if (rect.top >= 70 && rect.bottom <= window.innerHeight - 50) return;
    const main = $('#main');
    if (!main) return;
    const mainRect = main.getBoundingClientRect();
    // Scroll the container directly. Element.scrollIntoView() also walks
    // ancestors and can be interrupted by a focus() call, which makes the
    // viewport visibly jump while a cell is running.
    const top = clamp(
      main.scrollTop + (rect.top - mainRect.top) - (main.clientHeight - rect.height) / 2,
      0,
      Math.max(0, main.scrollHeight - main.clientHeight)
    );
    // Running all cells can start a new scroll before the previous animation
    // finishes; jump instantly in that case instead of stacking animations.
    const behavior = (options && options.instant) || state.runAllActive ? 'auto' : 'smooth';
    main.scrollTo({ top: top, behavior: behavior });
  }

  // ------------------------------------------------------------- cell actions

  function createInsertRow() {
    const row = el('div', 'insert-row');
    row.innerHTML = '<div class="insert-actions">' +
      '<button class="insert-btn" data-type="code">' + icon('plus') + ' Code</button>' +
      '<button class="insert-btn" data-type="markdown">' + icon('plus') + ' Text</button>' +
      '</div>';
    $$('.insert-btn', row).forEach((button) => {
      button.addEventListener('click', () => {
        const previous = row.previousElementSibling;
        const index = previous && previous.classList.contains('cell')
          ? indexOfCell(previous.dataset.id) + 1
          : state.notebook.cells.length;
        addCellAt(index, button.dataset.type, true);
      });
    });
    return row;
  }

  function insertCellNode(cell, index) {
    const cellsEl = $('#cells');
    const empty = $('.empty-state', cellsEl);
    if (empty) empty.remove();
    const existing = $$('.cell', cellsEl);
    const before = existing[index] || null;
    const node = createCellNode(cell);
    const row = createInsertRow();
    if (before) {
      cellsEl.insertBefore(node.root, before);
      cellsEl.insertBefore(row, before);
    } else {
      cellsEl.appendChild(node.root);
      cellsEl.appendChild(row);
    }
    return node;
  }

  function addCellAt(index, type, focus) {
    if (!state.notebook) return null;
    const at = clamp(index, 0, state.notebook.cells.length);
    const cell = makeCell(type, '');
    state.notebook.cells.splice(at, 0, cell);
    insertCellNode(cell, at);
    refreshEmptyState();
    updateMeta();
    scheduleSave();
    if (focus) {
      setActive(cell.id);
      scrollCellIntoView(cell);
      setTimeout(() => focusCell(cell, { scroll: false }), 20);
    }
    return cell;
  }

  function moveCell(cell, direction) {
    const index = indexOfCell(cell.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= state.notebook.cells.length) return;
    const node = state.nodes.get(cell.id);
    if (!node) return;
    const row = node.root.nextElementSibling;
    const cellsEl = $('#cells');
    if (direction < 0) {
      const previous = state.nodes.get(state.notebook.cells[target].id);
      cellsEl.insertBefore(node.root, previous.root);
      cellsEl.insertBefore(row, previous.root);
    } else {
      const next = state.nodes.get(state.notebook.cells[target].id);
      const anchor = next.root.nextElementSibling ? next.root.nextElementSibling.nextElementSibling : null;
      cellsEl.insertBefore(node.root, anchor);
      cellsEl.insertBefore(row, anchor);
    }
    const moved = state.notebook.cells.splice(index, 1)[0];
    state.notebook.cells.splice(target, 0, moved);
    setActive(cell.id);
    scheduleSave();
  }

  function deleteCell(cell) {
    const index = indexOfCell(cell.id);
    if (index < 0) return;
    const node = state.nodes.get(cell.id);
    const cm = state.editors.get(cell.id);
    if (cm) {
      try { cm.getWrapperElement().remove(); } catch (error) { /* ignore */ }
      state.editors.delete(cell.id);
    }
    // The undo snapshot keeps this object, so clear the edit flag as well.
    cell._editing = false;
    if (cell._formTimer) {
      clearTimeout(cell._formTimer);
      cell._formTimer = null;
    }
    state.nodes.delete(cell.id);
    if (node) {
      const row = node.root.nextElementSibling;
      node.root.classList.add('removing');
      setTimeout(() => {
        node.root.remove();
        if (row) row.remove();
      }, 130);
    }
    state.notebook.cells.splice(index, 1);
    refreshEmptyState();
    updateMeta();
    scheduleSave();
    const snapshot = cell;
    toast('Cell deleted', {
      type: 'info',
      action: {
        label: 'Undo',
        run: () => {
          state.notebook.cells.splice(index, 0, snapshot);
          renderNotebook();
          scheduleSave();
        },
      },
    });
  }

  function refreshEmptyState() {
    const cellsEl = $('#cells');
    let empty = $('.empty-state', cellsEl);
    if (!state.notebook) return;
    if (state.notebook.cells.length === 0) {
      if (!empty) {
        empty = el('div', 'empty-state');
        empty.innerHTML =
          '<div class="empty-icon">' + icon('terminal') + '</div>' +
          '<h2>Your notebook is empty</h2>' +
          '<p>Add a code cell to run Python, or a text cell to write.</p>' +
          '<div class="row"><button class="btn primary" data-empty="code">' + icon('code') + ' Code cell</button>' +
          '<button class="btn" data-empty="text">' + icon('text') + ' Text cell</button></div>';
        $('[data-empty="code"]', empty).addEventListener('click', () => addCellAt(0, 'code', true));
        $('[data-empty="text"]', empty).addEventListener('click', () => addCellAt(0, 'markdown', true));
        cellsEl.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
  }

  function renderCellChrome(cell) {
    const node = state.nodes.get(cell.id);
    if (!node) return;
    node.root.classList.toggle('running', cell.status === 'running');
    node.root.classList.toggle('error', !!cell.error);
    node.root.classList.toggle('has-run', cell.execCount != null);
    node.countEl.textContent = cell.execCount != null ? '[' + cell.execCount + ']' : '[ ]';
    if (node.runBtn) {
      node.runBtn.innerHTML = cell.status === 'running' ? '<span class="spinner"></span>' : icon('play');
      node.runBtn.title = cell.status === 'running' ? 'Interrupt execution' : 'Run cell (Shift + Enter)';
    }
    const running = cell.status === 'running';
    node.root.classList.toggle('has-foot', running || cell.duration != null);
    if (running) {
      node.footEl.innerHTML = '<span class="foot-running"><span class="spinner"></span><span class="elapsed">0.0s</span></span>';
    } else if (cell.duration != null) {
      node.footEl.innerHTML = '<span class="ok-dot"></span><span>' + (cell.error ? 'failed' : 'completed') + ' in ' + fmtDuration(cell.duration) + '</span>';
    } else {
      node.footEl.innerHTML = '';
    }
    node.root.classList.toggle('has-output', (cell.outputs || []).length > 0);
  }

  // ------------------------------------------------------------------- markdown

  function renderMarkdown(source) {
    if (!window.marked) return escapeHtml(source);
    try {
      const html = window.marked.parse(source, { gfm: true, breaks: false });
      return sanitizeHtml(html);
    } catch (error) {
      return escapeHtml(source);
    }
  }

  let sanitizerHooksInstalled = false;

  function installSanitizerHooks() {
    if (sanitizerHooksInstalled || !window.DOMPurify) return;
    sanitizerHooksInstalled = true;
    // GFM task lists render as disabled checkboxes. Let only those through;
    // every other form control is still blocked by FORBID_TAGS below.
    window.DOMPurify.addHook('afterSanitizeElements', (node) => {
      if (!node || node.nodeName !== 'INPUT') return;
      const type = String(node.getAttribute('type') || '').toLowerCase();
      if (type !== 'checkbox') {
        node.remove();
        return;
      }
      ['name', 'value', 'form', 'autofocus'].forEach((attribute) => node.removeAttribute(attribute));
      node.setAttribute('disabled', '');
    });
  }

  function sanitizeHtml(html) {
    if (!window.DOMPurify) return escapeHtml(html);
    installSanitizerHooks();
    return window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'button', 'textarea', 'select', 'option'],
      FORBID_ATTR: ['srcdoc'],
    });
  }

  function pythonHint(cm) {
    const cursor = cm.getCursor();
    const token = cm.getTokenAt(cursor);
    const start = token.start;
    const word = token.string.slice(0, cursor.ch - start);
    if (!word || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return null;
    const words = new Set(PY_KEYWORDS);
    const matches = cm.getValue().match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    matches.forEach((item) => words.add(item));
    const list = Array.from(words)
      .filter((item) => item !== word && item.toLowerCase().indexOf(word.toLowerCase()) === 0)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 40);
    if (!list.length) return null;
    return { list: list, from: CodeMirror.Pos(cursor.line, start), to: CodeMirror.Pos(cursor.line, cursor.ch) };
  }

  // ----------------------------------------------------------------- execution

  function enqueueExecution(cell, options) {
    if (!cell || cell.type !== 'code') return Promise.resolve();
    state.pending += 1;
    updateGlobalRunning();
    const task = state.queue.then(() => executeCell(cell, options));
    state.queue = task.catch(() => { /* keep the queue alive */ });
    return task.finally(() => {
      state.pending = Math.max(0, state.pending - 1);
      updateGlobalRunning();
    });
  }

  function runCellNow(cell) {
    enqueueExecution(cell);
  }

  function runAndAdvance(cell) {
    // The cell is about to advance, so do not scroll back to it when the
    // execution actually starts; that fights the scroll to the next cell.
    enqueueExecution(cell, { scroll: false });
    const index = indexOfCell(cell.id);
    const next = state.notebook.cells[index + 1];
    if (next) {
      setActive(next.id);
      scrollCellIntoView(next);
      if (next.type === 'code') setTimeout(() => focusCell(next, { scroll: false }), 10);
    } else {
      setTimeout(() => {
        const created = addCellAt(state.notebook.cells.length, 'code', false);
        focusCell(created);
      }, 10);
    }
  }

  function runAndInsert(cell) {
    // Let the newly inserted cell own the scroll instead of scrolling back
    // to the cell that is running.
    enqueueExecution(cell, { scroll: false });
    setTimeout(() => addCellAt(indexOfCell(cell.id) + 1, 'code', true), 10);
  }

  async function runAll() {
    if (state.runAllActive || !state.notebook) return;
    const cells = state.notebook.cells.filter((cell) => cell.type === 'code');
    if (!cells.length) {
      toast('There are no code cells to run', { type: 'warn' });
      return;
    }
    state.runAllActive = true;
    state.stopRequested = false;
    updateGlobalRunning();
    try {
      for (let i = 0; i < cells.length; i += 1) {
        if (state.stopRequested) break;
        await enqueueExecution(cells[i]);
      }
    } finally {
      state.runAllActive = false;
      updateGlobalRunning();
    }
  }

  function updateGlobalRunning() {
    const busy = state.pending > 0 || state.runAllActive;
    const stop = $('#stop-btn');
    const progress = $('#run-progress');
    const button = $('#run-all-btn');
    if (stop) stop.hidden = !busy;
    if (progress) progress.hidden = !busy;
    if (button) {
      button.disabled = busy;
      button.innerHTML = busy
        ? '<span class="spinner" style="width:12px;height:12px;border-color:rgba(255,255,255,.35);border-top-color:#fff"></span><span>Running</span>'
        : icon('play') + '<span>Run all</span>';
    }
  }

  async function stopExecution() {
    state.stopRequested = true;
    if (state.abort) {
      try { state.abort.abort(); } catch (error) { /* ignore */ }
    }
    try { await fetch('/api/interrupt', { method: 'POST' }); } catch (error) { /* ignore */ }
    state.kernel = Object.assign({}, state.kernel, { alive: false, busy: false });
    updateKernelUI();
    toast('Execution interrupted', { type: 'warn' });
    setTimeout(() => { state.stopRequested = false; }, 500);
    setTimeout(pollStatus, 900);
  }

  async function executeCell(cell, options) {
    if (!cell || cell.type !== 'code' || state.stopRequested) return;
    const node = state.nodes.get(cell.id);
    if (!node) return;

    cell.outputs = [];
    cell.error = false;
    cell.duration = null;
    cell.status = 'running';
    cell.startedAt = performance.now();
    node.outputsEl.innerHTML = '';
    node.root.classList.remove('has-output');
    renderCellChrome(cell);
    if (!options || options.scroll !== false) scrollCellIntoView(cell);

    const controller = new AbortController();
    state.abort = controller;

    try {
      const response = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cell.source, id: cell.id }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('The server responded with HTTP ' + response.status + '.');
      if (!response.body) throw new Error('This browser does not support streaming responses.');
      await readEventStream(response.body, (message) => handleKernelMessage(cell, message));
    } catch (error) {
      if (error && error.name === 'AbortError') {
        addStreamOutput(cell, 'stderr', '\n[execution interrupted]\n');
      } else {
        const message = error && error.message ? error.message : String(error);
        cell.error = true;
        addOutput(cell, {
          kind: 'error',
          ename: 'ConnectionError',
          evalue: message,
          traceback: [message, '', 'Make sure the Cobalt server is still running, then try again.'],
        });
      }
    } finally {
      cell.status = 'idle';
      if (cell.duration == null) cell.duration = Math.max(1, performance.now() - cell.startedAt);
      if (state.abort === controller) state.abort = null;
      renderCellChrome(cell);
      scheduleSave();
      refreshVars();
    }
  }

  async function readEventStream(body, onMessage) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          block.split('\n').forEach((line) => {
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload) return;
            try { onMessage(JSON.parse(payload)); } catch (error) { console.warn('Bad event payload', error); }
          });
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (error) { /* ignore */ }
    }
  }

  function handleKernelMessage(cell, message) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'start':
        cell.execCount = message.count;
        renderCellChrome(cell);
        break;
      case 'stream':
        addStreamOutput(cell, message.name || 'stdout', message.text || '');
        break;
      case 'result':
        addOutput(cell, { kind: 'result', data: message.data || {} });
        break;
      case 'display':
        if (message.display_id) {
          upsertDisplayOutput(cell, message.display_id, message.data || {});
        } else {
          addOutput(cell, { kind: 'display', data: message.data || {} });
        }
        break;
      case 'error':
        cell.error = true;
        addOutput(cell, {
          kind: 'error',
          ename: message.ename || 'Error',
          evalue: message.evalue || '',
          traceback: message.traceback || [],
        });
        break;
      case 'input_request':
        showInputRequest(cell, message);
        break;
      case 'done':
        if (typeof message.duration === 'number') cell.duration = Math.max(1, message.duration * 1000);
        if (message.status === 'error') cell.error = true;
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------- outputs

  function addOutput(cell, output) {
    cell.outputs.push(output);
    const node = state.nodes.get(cell.id);
    if (!node) return output;
    node.root.classList.add('has-output');
    const built = buildOutputElement(output);
    if (built) {
      output._el = built;
      node.outputsEl.appendChild(built);
    }
    return output;
  }

  function upsertDisplayOutput(cell, displayId, data) {
    let output = (cell.outputs || []).find((item) => item && item.displayId === displayId);
    if (!output) {
      return addOutput(cell, { kind: 'display', displayId: displayId, data: data });
    }
    output.data = data;
    const node = state.nodes.get(cell.id);
    if (!node) return output;
    const built = buildOutputElement(output);
    if (!built) return output;
    if (output._el && output._el.parentNode === node.outputsEl) {
      output._el.replaceWith(built);
    } else {
      node.outputsEl.appendChild(built);
    }
    output._el = built;
    node.root.classList.add('has-output');
    return output;
  }

  function addStreamOutput(cell, name, text) {
    if (!text) return;
    const outputs = cell.outputs;
    const last = outputs[outputs.length - 1];
    if (last && last.kind === 'stream' && last.name === name) {
      if (last.text.length < MAX_STREAM_CHARS) last.text += text;
    } else {
      outputs.push({ kind: 'stream', name: name, text: text });
    }

    const node = state.nodes.get(cell.id);
    if (!node) return;
    node.root.classList.add('has-output');
    let holder = node.outputsEl.lastElementChild;
    if (!holder || holder.dataset.stream !== name) {
      holder = el('div', 'out out-stream ' + (name === 'stderr' ? 'stderr' : 'stdout'));
      holder.dataset.stream = name;
      holder.appendChild(el('pre'));
      holder._len = 0;
      node.outputsEl.appendChild(holder);
    }
    holder._len = (holder._len || 0) + text.length;
    if (holder._len > MAX_STREAM_CHARS) {
      if (!holder._truncated) {
        holder._truncated = true;
        holder.querySelector('pre').appendChild(document.createTextNode('\n[output truncated — too much text]\n'));
      }
      return;
    }
    holder.querySelector('pre').appendChild(document.createTextNode(text));
  }

  function renderOutputs(cell) {
    const node = state.nodes.get(cell.id);
    if (!node) return;
    node.outputsEl.innerHTML = '';
    if (!cell.outputs || !cell.outputs.length) {
      node.root.classList.remove('has-output');
      return;
    }
    cell.outputs.forEach((output) => {
      const built = buildOutputElement(output);
      if (built) {
        output._el = built;
        node.outputsEl.appendChild(built);
      }
    });
    node.root.classList.add('has-output');
  }

  function pickMime(data) {
    if (!data) return { kind: 'text', value: '' };
    if (data['text/html']) return { kind: 'html', value: data['text/html'] };
    if (data['image/svg+xml']) return { kind: 'svg', value: data['image/svg+xml'] };
    if (data['image/png']) return { kind: 'image', mime: 'image/png', value: data['image/png'] };
    if (data['image/jpeg']) return { kind: 'image', mime: 'image/jpeg', value: data['image/jpeg'] };
    if (data['text/markdown']) return { kind: 'markdown', value: data['text/markdown'] };
    if (data['application/json']) return { kind: 'json', value: data['application/json'] };
    return { kind: 'text', value: data['text/plain'] != null ? String(data['text/plain']) : '' };
  }

  function buildOutputElement(output) {
    if (output.kind === 'stream') {
      const wrap = el('div', 'out out-stream ' + (output.name === 'stderr' ? 'stderr' : 'stdout'));
      wrap.dataset.stream = output.name || 'stdout';
      const pre = el('pre');
      pre.textContent = output.text || '';
      wrap.appendChild(pre);
      wrap._len = (output.text || '').length;
      return wrap;
    }

    if (output.kind === 'error') return buildErrorElement(output);

    const picked = pickMime(output.data);
    const wrap = el('div', 'out ' + (output.kind === 'result' ? 'out-result' : 'out-display'));

    if (picked.kind === 'text') {
      const pre = el('pre');
      pre.textContent = picked.value;
      wrap.appendChild(pre);
    } else if (picked.kind === 'json') {
      const pre = el('pre');
      try { pre.textContent = JSON.stringify(picked.value, null, 2); } catch (error) { pre.textContent = String(picked.value); }
      wrap.appendChild(pre);
    } else if (picked.kind === 'image') {
      const holder = el('div', 'out-image');
      const image = el('img');
      image.src = 'data:' + picked.mime + ';base64,' + picked.value;
      image.alt = 'Notebook output';
      image.addEventListener('click', () => openLightbox(image.src));
      holder.appendChild(image);
      wrap.appendChild(holder);
    } else if (picked.kind === 'html' || picked.kind === 'svg') {
      const holder = el('div', 'out-html');
      holder.innerHTML = sanitizeHtml(picked.value);
      fitOverflowingSvg(holder);
      wrap.appendChild(holder);
    } else if (picked.kind === 'markdown') {
      const holder = el('div', 'prose out-md');
      holder.innerHTML = renderMarkdown(picked.value);
      fitOverflowingSvg(holder);
      wrap.appendChild(holder);
    }
    return wrap;
  }

  // SVG drawings can paint far outside their viewBox when overflow is visible.
  // That ink does not count toward a scroll container's scrollWidth, so it gets
  // clipped by the page instead of becoming scrollable. Expand the viewBox to
  // cover the drawing and let .out-html scroll it horizontally.
  function fitOverflowingSvg(holder) {
    if (!holder) return;
    requestAnimationFrame(() => {
      if (!holder.isConnected) return;
      $$('svg', holder).forEach((svg) => {
        // Leave nested SVGs alone; their coordinates belong to a parent.
        if (svg.parentElement && svg.parentElement.closest('svg')) return;
        let box;
        try { box = svg.getBBox(); } catch (error) { return; }
        if (!box || !isFinite(box.x) || !isFinite(box.y) || !(box.width > 0) || !(box.height > 0)) return;

        const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
        const rect = svg.getBoundingClientRect();
        const baseW = vb && vb.width > 0 ? vb.width : (rect.width || (svg.width && svg.width.baseVal.value) || 0);
        const baseH = vb && vb.height > 0 ? vb.height : (rect.height || (svg.height && svg.height.baseVal.value) || 0);
        if (!(baseW > 0) || !(baseH > 0)) return;

        const baseX = vb && vb.width > 0 ? vb.x : 0;
        const baseY = vb && vb.height > 0 ? vb.y : 0;
        const minX = Math.min(baseX, box.x);
        const minY = Math.min(baseY, box.y);
        const maxX = Math.max(baseX + baseW, box.x + box.width);
        const maxY = Math.max(baseY + baseH, box.y + box.height);
        const width = maxX - minX;
        const height = maxY - minY;
        if (width <= baseW + 1 && height <= baseH + 1) return;

        // Keep the SVG's current display scale so the drawing does not jump
        // size when its viewport is widened.
        const scaleX = rect.width > 0 ? rect.width / baseW : 1;
        const scaleY = rect.height > 0 ? rect.height / baseH : scaleX;
        svg.setAttribute('viewBox', [minX, minY, width, height].join(' '));
        svg.style.maxWidth = 'none';
        svg.style.width = Math.ceil(width * scaleX) + 'px';
        svg.style.height = Math.ceil(height * scaleY) + 'px';
      });
    });
  }

  function buildErrorElement(output) {
    const wrap = el('div', 'out out-error');
    const head = el('div', 'out-error-head');
    head.innerHTML = icon('alert') +
      '<div class="err-titles"><div class="err-name"></div><div class="err-value"></div></div>' +
      '<button class="err-toggle">Hide traceback</button>';
    $('.err-name', head).textContent = output.ename || 'Error';
    $('.err-value', head).textContent = output.evalue || '';

    const pre = el('pre');
    const lines = Array.isArray(output.traceback) ? output.traceback.slice() : [];
    const last = lines[lines.length - 1] || '';
    if (output.ename && last.indexOf(output.ename) === 0) lines.pop();
    pre.textContent = lines.join('\n');

    wrap.appendChild(head);
    if (pre.textContent.trim()) {
      const toggle = $('.err-toggle', head);
      toggle.addEventListener('click', () => {
        pre.classList.toggle('collapsed');
        toggle.textContent = pre.classList.contains('collapsed') ? 'Show traceback' : 'Hide traceback';
      });
      wrap.appendChild(pre);
    } else {
      const toggle = $('.err-toggle', head);
      if (toggle) toggle.remove();
    }
    return wrap;
  }

  function showInputRequest(cell, message) {
    const node = state.nodes.get(cell.id);
    if (!node) return;
    node.root.classList.add('has-output');
    const wrap = el('div', 'out out-input');
    const prompt = el('span', 'prompt', message.prompt || '');
    const input = el('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Type your answer and press Enter';
    const button = el('button', 'mini-btn', 'Send');
    wrap.appendChild(prompt);
    wrap.appendChild(input);
    wrap.appendChild(button);
    node.outputsEl.appendChild(wrap);
    setTimeout(() => input.focus(), 20);

    const submit = () => {
      const value = input.value;
      fetch('/api/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: message.id, value: value }),
      }).catch(() => { /* the kernel will time out or be interrupted */ });
      const done = el('div', 'out out-input-done');
      const promptSpan = el('span', 'prompt');
      promptSpan.textContent = message.prompt || '';
      const answer = el('b');
      answer.textContent = value;
      done.appendChild(promptSpan);
      done.appendChild(answer);
      wrap.replaceWith(done);
    };

    button.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
    });
  }

  function openLightbox(src) {
    const wrap = el('div', 'lightbox');
    const image = el('img');
    image.src = src;
    wrap.appendChild(image);
    wrap.addEventListener('click', () => wrap.remove());
    document.body.appendChild(wrap);
  }

  // ------------------------------------------------------------- ipynb format

  function toIpynb(notebook) {
    return {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
        cobalt: { version: 1 },
      },
      cells: notebook.cells.map((cell) => {
        if (cell.type === 'markdown') {
          return { cell_type: 'markdown', metadata: {}, source: cell.source };
        }
        return {
          cell_type: 'code',
          execution_count: cell.execCount == null ? null : cell.execCount,
          metadata: {},
          outputs: (cell.outputs || []).map(toNbOutput).filter(Boolean),
          source: cell.source,
        };
      }),
    };
  }

  function toNbOutput(output) {
    if (output.kind === 'stream') {
      return { output_type: 'stream', name: output.name || 'stdout', text: output.text || '' };
    }
    if (output.kind === 'error') {
      return { output_type: 'error', ename: output.ename || 'Error', evalue: output.evalue || '', traceback: output.traceback || [] };
    }
    if (output.kind === 'result' || output.kind === 'display') {
      const data = Object.assign({}, output.data || {});
      if (!data['text/plain']) data['text/plain'] = '';
      return { output_type: 'display_data', data: data, metadata: {} };
    }
    return null;
  }

  function fromIpynb(raw, title) {
    const cells = (raw.cells || []).map((rawCell) => {
      const source = Array.isArray(rawCell.source) ? rawCell.source.join('') : String(rawCell.source || '');
      if (rawCell.cell_type === 'markdown' || rawCell.cell_type === 'raw') {
        return makeCell('markdown', source);
      }
      const cell = makeCell('code', source);
      cell.execCount = rawCell.execution_count == null ? null : rawCell.execution_count;
      cell.outputs = (rawCell.outputs || []).map(fromNbOutput).filter(Boolean);
      cell.error = cell.outputs.some((output) => output.kind === 'error');
      return cell;
    });
    return {
      id: uid(),
      title: title || 'Imported notebook',
      created: Date.now(),
      updated: Date.now(),
      cells: cells.length ? cells : [makeCell('code', '')],
    };
  }

  function fromNbOutput(raw) {
    if (!raw || !raw.output_type) return null;
    if (raw.output_type === 'stream') {
      return { kind: 'stream', name: raw.name || 'stdout', text: Array.isArray(raw.text) ? raw.text.join('') : String(raw.text || '') };
    }
    if (raw.output_type === 'error') {
      return { kind: 'error', ename: raw.ename || 'Error', evalue: raw.evalue || '', traceback: raw.traceback || [] };
    }
    if (raw.output_type === 'execute_result' || raw.output_type === 'display_data') {
      return {
        kind: raw.output_type === 'execute_result' ? 'result' : 'display',
        data: normalizeData(raw.data),
      };
    }
    return null;
  }

  function normalizeData(data) {
    const normalized = {};
    Object.keys(data || {}).forEach((key) => {
      const value = data[key];
      normalized[key] = Array.isArray(value) ? value.join('') : value;
    });
    return normalized;
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadIpynb() {
    if (!state.notebook) return;
    saveNow();
    downloadFile(slugify(state.notebook.title) + '.ipynb', JSON.stringify(toIpynb(state.notebook), null, 1), 'application/json');
    toast('Notebook exported as .ipynb', { type: 'success' });
  }

  function downloadPython() {
    if (!state.notebook) return;
    const lines = ['# Exported from Cobalt', '# ' + state.notebook.title, ''];
    state.notebook.cells.forEach((cell) => {
      if (cell.type === 'markdown') {
        lines.push('# %% [markdown]');
        (cell.source || '').split('\n').forEach((line) => lines.push('# ' + line));
      } else {
        lines.push('# %%');
        lines.push(cell.source || '');
      }
      lines.push('');
    });
    downloadFile(slugify(state.notebook.title) + '.py', lines.join('\n'), 'text/x-python;charset=utf-8');
    toast('Notebook exported as .py', { type: 'success' });
  }

  function importIpynbFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        if (!raw || !Array.isArray(raw.cells)) throw new Error('This file does not look like a notebook.');
        if (state.notebook) saveNow();
        const notebook = fromIpynb(raw, file.name.replace(/\.ipynb$/i, ''));
        const store = loadStore();
        store[notebook.id] = serializableNotebook(notebook);
        persistStore(store);
        state.notebooks = store;
        state.notebook = notebook;
        state.activeCellId = notebook.cells[0] ? notebook.cells[0].id : null;
        try { localStorage.setItem(LS_CURRENT, notebook.id); } catch (error) { /* ignore */ }
        renderNotebook();
        renderNotebookList();
        updateMeta();
        setSaveState('saved');
        toast('Imported ' + file.name, { type: 'success' });
      } catch (error) {
        toast('Import failed: ' + (error.message || error), { type: 'error' });
      }
    };
    reader.readAsText(file);
  }

  // --------------------------------------------------------------------- ui

  function toast(message, options) {
    const opts = options || {};
    const holder = $('#toasts');
    if (!holder) return function () {};
    const node = el('div', 'toast ' + (opts.type || ''));
    const iconName = opts.type === 'error' ? 'alert' : opts.type === 'warn' ? 'alert' : opts.type === 'success' ? 'check' : 'zap';
    node.innerHTML = icon(iconName) + '<span class="toast-text"></span>';
    $('.toast-text', node).textContent = message;
    holder.appendChild(node);

    let timer = null;
    const remove = () => {
      if (!node.isConnected) return;
      clearTimeout(timer);
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 180);
    };
    if (opts.action && typeof opts.action.run === 'function') {
      const action = el('button', 'toast-action', opts.action.label || 'Undo');
      action.addEventListener('click', () => { remove(); opts.action.run(); });
      node.appendChild(action);
    }
    timer = setTimeout(remove, opts.timeout || 4200);
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    return remove;
  }

  function updateKernelUI() {
    const status = state.kernel || {};
    const dotClass = status.unknown ? 'busy' : status.alive ? (status.busy ? 'busy' : 'ok') : 'error';
    const dot = $('#kernel-dot');
    if (dot) dot.className = 'status-dot ' + dotClass;
    const runtimeDot = $('#runtime-dot');
    if (runtimeDot) runtimeDot.className = 'status-dot ' + dotClass;
    const label = $('#kernel-label');
    if (label) label.textContent = status.unknown ? 'Starting…' : status.alive ? 'Python ' + (status.python || '') : 'Kernel offline';
    const runtimeState = $('#runtime-state');
    if (runtimeState) runtimeState.textContent = status.unknown ? 'Starting' : status.busy ? 'Busy' : status.alive ? 'Idle' : 'Offline';
    const runtimeMeta = $('#runtime-meta');
    if (runtimeMeta) runtimeMeta.textContent = status.unknown ? 'Booting CPython…' : status.alive ? (status.cwd || '') : 'Run a cell to start the kernel';
    const metaKernel = $('#meta-kernel');
    if (metaKernel) metaKernel.textContent = status.alive && status.python ? 'Python ' + status.python : 'Python';
    const popover = $('#kernel-popover');
    if (popover) renderKernelPopover(popover);
  }

  async function pollStatus() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('status unavailable');
      state.kernel = await response.json();
    } catch (error) {
      state.kernel = { unknown: false, alive: false, busy: false, packages: [] };
    }
    updateKernelUI();
  }

  function renderKernelPopover(popover) {
    const status = state.kernel || {};
    const dotClass = status.unknown ? 'busy' : status.alive ? (status.busy ? 'busy' : 'ok') : 'error';
    const packages = status.packages || [];
    const stateLabel = status.unknown ? 'Starting' : status.busy ? 'Busy' : status.alive ? 'Idle' : 'Offline';
    popover.innerHTML =
      '<div class="popover-title"><span class="status-dot ' + dotClass + '"></span> Local Python runtime' +
        '<span style="margin-left:auto;font-size:9.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.07em">' + stateLabel + '</span>' +
      '</div>' +
      '<div class="popover-sub">' + (status.alive
        ? 'A persistent CPython process running on this machine.'
        : 'The kernel starts automatically when you run a cell.') + '</div>' +
      '<dl class="popover-grid">' +
        '<dt>Version</dt><dd>' + escapeHtml(status.python || '—') + '</dd>' +
        '<dt>Uptime</dt><dd>' + (status.alive ? fmtUptime(status.uptime) : '—') + '</dd>' +
        '<dt>Workspace</dt><dd title="' + escapeHtml(status.cwd || '') + '">' + escapeHtml(status.cwd || '—') + '</dd>' +
        '<dt>Executions</dt><dd>' + (status.executions == null ? 0 : status.executions) + '</dd>' +
      '</dl>' +
      '<div class="popover-chips">' +
        (packages.length
          ? packages.map((name) => '<span class="chip on">' + escapeHtml(name) + '</span>').join('')
          : '<span class="chip">stdlib</span>') +
      '</div>' +
      '<div class="popover-actions">' +
        '<button class="mini-btn" data-pop="restart">' + icon('refresh') + '<span>Restart</span></button>' +
        '<button class="mini-btn danger" data-pop="interrupt">' + icon('stop') + '<span>Interrupt</span></button>' +
      '</div>';
    $('[data-pop="restart"]', popover).addEventListener('click', () => { closePopovers(); restartKernel(false); });
    $('[data-pop="interrupt"]', popover).addEventListener('click', () => { closePopovers(); stopExecution(); });
  }

  function openKernelPopover(anchor) {
    const existing = $('#kernel-popover');
    if (existing) { existing.remove(); return; }
    closePopovers();
    const popover = el('div', 'popover');
    popover.id = 'kernel-popover';
    document.body.appendChild(popover);
    renderKernelPopover(popover);
    const rect = anchor.getBoundingClientRect();
    popover.style.top = (rect.bottom + 9) + 'px';
    popover.style.right = Math.max(10, window.innerWidth - rect.right) + 'px';
  }

  function closePopovers() {
    $$('.popover').forEach((popover) => popover.remove());
  }

  function refreshVars() {
    clearTimeout(state.varsTimer);
    state.varsTimer = setTimeout(async () => {
      try {
        const response = await fetch('/api/vars', { cache: 'no-store' });
        const data = await response.json();
        state.vars = data.items || [];
        const badge = $('#vars-badge');
        if (badge) {
          badge.textContent = state.vars.length;
          badge.hidden = state.vars.length === 0;
        }
        renderVars(data);
      } catch (error) { /* offline */ }
    }, 350);
  }

  function renderVars(data) {
    const list = $('#vars-list');
    if (!list) return;
    if (data && data.busy) {
      list.innerHTML = '<div class="empty-mini">The kernel is busy…</div>';
      return;
    }
    const items = (data && data.items) || [];
    if (!items.length) {
      list.innerHTML = '<div class="empty-mini">' + icon('box') + '<div>No variables yet.<br>Run a cell to populate memory.</div></div>';
      return;
    }
    list.innerHTML = '';
    items.forEach((item) => {
      const card = el('button', 'var-card');
      card.type = 'button';
      card.title = 'Copy variable name';
      card.innerHTML = '<div class="var-head"><span class="var-name"></span><span class="var-type"></span></div><div class="var-repr"></div>';
      $('.var-name', card).textContent = item.name;
      $('.var-type', card).textContent = item.type;
      $('.var-repr', card).textContent = item.repr;
      card.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.name);
          toast('Copied ' + item.name, { type: 'success' });
        } catch (error) {
          toast('Could not access the clipboard', { type: 'warn' });
        }
      });
      list.appendChild(card);
    });
  }

  function openTypeMenu(cell, anchor) {
    closePopovers();
    const menu = el('div', 'popover');
    menu.style.width = '152px';
    menu.style.padding = '5px';
    menu.innerHTML =
      '<button class="menu-item" data-type="code">' + icon('code') + '<span>Code</span></button>' +
      '<button class="menu-item" data-type="markdown">' + icon('text') + '<span>Text</span></button>';
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 160, rect.left - 40)) + 'px';
    $$('[data-type]', menu).forEach((button) => {
      button.addEventListener('click', () => {
        closePopovers();
        setCellType(cell, button.dataset.type);
      });
    });
  }

  function setCellType(cell, type) {
    if (!cell || cell.type === type) return;
    const node = state.nodes.get(cell.id);
    const cm = state.editors.get(cell.id);
    if (cm) {
      try { cm.getWrapperElement().remove(); } catch (error) { /* ignore */ }
      state.editors.delete(cell.id);
    }
    cell.type = type;
    cell.outputs = [];
    cell.error = false;
    cell.duration = null;
    cell.execCount = null;
    cell._editing = false;
    const replacement = createCellNode(cell);
    if (node) node.root.replaceWith(replacement.root);
    else renderNotebook();
    scheduleSave();
    updateMeta();
    setActive(cell.id);
    if (type === 'code') setTimeout(() => focusCell(cell), 20);
    else setTimeout(() => enterMarkdownEdit(cell), 20);
  }

  // ------------------------------------------------------------------ palette

  function paletteCommands() {
    return [
      { label: 'Run all cells', hint: '', icon: 'play', run: runAll },
      { label: 'Restart runtime', hint: '', icon: 'refresh', run: () => restartKernel(false) },
      { label: 'Interrupt execution', hint: '', icon: 'stop', run: () => stopExecution() },
      { label: 'Add code cell', hint: '', icon: 'code', run: () => addCellAt(state.notebook.cells.length, 'code', true) },
      { label: 'Add text cell', hint: '', icon: 'text', run: () => addCellAt(state.notebook.cells.length, 'markdown', true) },
      { label: 'New notebook', hint: '', icon: 'plus', run: () => newNotebook() },
      { label: 'Duplicate notebook', hint: '', icon: 'copy', run: duplicateNotebook },
      { label: 'Open sample notebook', hint: '', icon: 'file', run: () => newNotebook('Welcome to Cobalt', WELCOME_CELLS) },
      { label: 'Download .ipynb', hint: '', icon: 'download', run: downloadIpynb },
      { label: 'Download .py', hint: '', icon: 'file', run: downloadPython },
      { label: 'Import .ipynb…', hint: '', icon: 'upload', run: () => $('#file-input').click() },
      { label: 'Clear all outputs', hint: '', icon: 'refresh', run: clearAllOutputs },
      { label: 'Toggle theme', hint: 'Ctrl J', icon: 'sun', run: toggleTheme },
      { label: 'Toggle sidebar', hint: 'Ctrl B', icon: 'panel-left', run: toggleSidebar },
      { label: 'Keyboard shortcuts', hint: '', icon: 'keyboard', run: openShortcuts },
    ];
  }

  function openPalette() {
    closePalette();
    const wrap = el('div', 'palette-wrap');
    wrap.id = 'palette';
    wrap.innerHTML =
      '<div class="palette" role="dialog" aria-modal="true">' +
        '<div class="palette-input-row">' + icon('search') +
          '<input class="palette-input" placeholder="Search commands…" autocomplete="off" spellcheck="false">' +
          '<kbd class="palette-esc">esc</kbd>' +
        '</div>' +
        '<div class="palette-list" role="listbox"></div>' +
      '</div>';
    document.body.appendChild(wrap);

    const input = $('.palette-input', wrap);
    const list = $('.palette-list', wrap);
    const all = paletteCommands();
    let filtered = all.slice();
    let active = 0;

    const updateActive = () => {
      Array.from(list.children).forEach((child, index) => {
        child.classList.toggle('active', index === active);
      });
    };

    const render = () => {
      list.innerHTML = '';
      if (!filtered.length) {
        list.innerHTML = '<div class="palette-empty">No commands match that search.</div>';
        return;
      }
      filtered.forEach((command, index) => {
        const item = el('div', 'palette-item' + (index === active ? ' active' : ''));
        item.innerHTML = icon(command.icon) + '<span></span>' + (command.hint ? '<kbd>' + command.hint + '</kbd>' : '');
        $('span', item).textContent = command.label;
        item.addEventListener('pointerenter', () => { active = index; updateActive(); });
        item.addEventListener('click', () => { closePalette(); command.run(); });
        list.appendChild(item);
      });
    };

    const runActive = () => {
      const command = filtered[active];
      if (command) { closePalette(); command.run(); }
    };

    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      filtered = all.filter((command) => command.label.toLowerCase().indexOf(query) !== -1);
      active = 0;
      render();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(filtered.length - 1, active + 1); updateActive(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, active - 1); updateActive(); }
      else if (event.key === 'Enter') { event.preventDefault(); runActive(); }
      else if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
    });

    wrap.addEventListener('pointerdown', (event) => { if (event.target === wrap) closePalette(); });
    render();
    setTimeout(() => input.focus(), 20);
  }

  function closePalette() {
    const palette = $('#palette');
    if (palette) palette.remove();
  }

  function openModal(html, className) {
    closeModal();
    const wrap = el('div', 'modal-backdrop');
    wrap.id = 'modal';
    wrap.innerHTML = '<div class="modal ' + (className || '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    wrap.addEventListener('pointerdown', (event) => { if (event.target === wrap) closeModal(); });
    $('#modal-root').appendChild(wrap);
    return wrap;
  }

  function closeModal() {
    const modal = $('#modal');
    if (modal) modal.remove();
  }

  function openShortcuts() {
    const rows = [
      ['Running', null],
      ['Run cell and advance', 'Shift Enter'],
      ['Run cell in place', 'Ctrl Enter'],
      ['Run cell and insert below', 'Alt Enter'],
      ['Workspace', null],
      ['Command palette', 'Ctrl K'],
      ['Save notebook', 'Ctrl S'],
      ['Toggle theme', 'Ctrl J'],
      ['Toggle sidebar', 'Ctrl B'],
      ['Toggle comment', 'Ctrl /'],
      ['Autocomplete', 'Ctrl Space'],
      ['Leave editor / close layer', 'Esc'],
      ['Editing', null],
      ['Edit a text cell', 'Double click'],
      ['Preview Markdown', 'Ctrl Enter'],
      ['Shell escape', '! command'],
      ['Ask for input', 'input()'],
    ];
    let grid = '<div class="shortcut-grid">';
    rows.forEach((row) => {
      if (row[1] === null) {
        grid += '<div class="shortcut-section">' + row[0] + '</div>';
      } else {
        grid += '<div class="shortcut-row"><span>' + row[0] + '</span><kbd>' + row[1] + '</kbd></div>';
      }
    });
    grid += '</div>';

    openModal(
      '<div class="modal-head">' + icon('keyboard') +
        '<div class="modal-title">Keyboard shortcuts</div>' +
        '<span class="modal-sub">Cobalt</span>' +
        '<button class="icon-btn modal-close" aria-label="Close">' + icon('x') + '</button>' +
      '</div>' +
      '<div class="modal-body">' + grid +
        '<p style="margin:18px 0 0;font-size:11.5px;color:var(--muted);line-height:1.6">' +
        'Everything executes locally. Use <code style="font-family:var(--font-mono)">!command</code> for a shell escape, ' +
        '<code style="font-family:var(--font-mono)">display()</code> for rich output, and ' +
        '<code style="font-family:var(--font-mono)">input()</code> for an inline prompt.' +
        '</p>' +
      '</div>'
    );
    $('.modal-close').addEventListener('click', closeModal);
  }

  function closeTopLayer() {
    if ($('#palette')) { closePalette(); return true; }
    if ($('#modal')) { closeModal(); return true; }
    const lightbox = $('.lightbox');
    if (lightbox) { lightbox.remove(); return true; }
    if ($('.popover')) { closePopovers(); return true; }
    const dropdown = $('#menu-dropdown');
    if (dropdown && !dropdown.hidden) { dropdown.hidden = true; return true; }
    return false;
  }

  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem(LS_THEME, next); } catch (error) { /* ignore */ }
    state.editors.forEach((cm) => { try { cm.refresh(); } catch (error) { /* ignore */ } });
  }

  function toggleSidebar() {
    const app = $('.app');
    if (window.innerWidth <= 860) app.classList.toggle('sidebar-open');
    else app.classList.toggle('sidebar-collapsed');
    setTimeout(() => state.editors.forEach((cm) => { try { cm.refresh(); } catch (error) { /* ignore */ } }), 240);
  }

  function clearAllOutputs() {
    if (!state.notebook) return;
    state.notebook.cells.forEach((cell) => {
      cell.outputs = [];
      cell.error = false;
      cell.duration = null;
      const node = state.nodes.get(cell.id);
      if (node) {
        node.outputsEl.innerHTML = '';
        node.root.classList.remove('has-output', 'error');
      }
      renderCellChrome(cell);
    });
    scheduleSave();
    toast('All outputs cleared', { type: 'success' });
  }

  async function restartKernel(clearOutputs) {
    if (state.abort) { try { state.abort.abort(); } catch (error) { /* ignore */ } }
    try {
      const response = await fetch('/api/restart', { method: 'POST' });
      const data = await response.json();
      if (data && data.kernel) {
        state.kernel = {
          alive: true,
          busy: false,
          python: data.kernel.python,
          executable: data.kernel.executable,
          cwd: data.kernel.cwd,
          packages: data.kernel.packages || [],
          uptime: 0,
          executions: 0,
        };
      }
    } catch (error) {
      toast('Could not restart the runtime', { type: 'error' });
    }
    if (state.notebook) {
      state.notebook.cells.forEach((cell) => {
        cell.execCount = null;
        if (clearOutputs) {
          cell.outputs = [];
          cell.error = false;
          cell.duration = null;
          const node = state.nodes.get(cell.id);
          if (node) {
            node.outputsEl.innerHTML = '';
            node.root.classList.remove('has-output', 'error');
          }
        }
        renderCellChrome(cell);
      });
    }
    state.vars = [];
    renderVars({ items: [], busy: false });
    const badge = $('#vars-badge');
    if (badge) badge.hidden = true;
    updateKernelUI();
    toast(clearOutputs ? 'Runtime restarted · outputs cleared' : 'Runtime restarted', { type: 'success' });
    setTimeout(pollStatus, 600);
  }

  function handleMenuAction(action) {
    if (action === 'export-ipynb') downloadIpynb();
    else if (action === 'export-py') downloadPython();
    else if (action === 'import') $('#file-input').click();
    else if (action === 'duplicate') duplicateNotebook();
    else if (action === 'clear-outputs') clearAllOutputs();
    else if (action === 'restart') restartKernel(false);
    else if (action === 'new') newNotebook();
  }

  // -------------------------------------------------------------------- boot

  function tickRunning() {
    if (!state.notebook) return;
    $$('.cell.running').forEach((node) => {
      const cell = state.notebook.cells.find((item) => item.id === node.dataset.id);
      if (!cell || !cell.startedAt) return;
      const elapsed = node.querySelector('.foot-running .elapsed');
      if (elapsed) elapsed.textContent = ((performance.now() - cell.startedAt) / 1000).toFixed(1) + 's';
    });
  }

  function bindEvents() {
    $('#sidebar-toggle').addEventListener('click', toggleSidebar);
    $('#sidebar-backdrop').addEventListener('click', () => $('.app').classList.remove('sidebar-open'));

    $('#new-nb-btn').addEventListener('click', () => newNotebook());
    $('#examples-btn').addEventListener('click', () => {
      newNotebook('Welcome to Cobalt', WELCOME_CELLS);
      toast('Demo notebook loaded — press Shift + Enter on a cell', { type: 'success' });
    });

    $$('#sidebar-tabs .seg').forEach((seg) => {
      seg.addEventListener('click', () => {
        $$('#sidebar-tabs .seg').forEach((other) => {
          other.classList.toggle('active', other === seg);
          other.setAttribute('aria-selected', String(other === seg));
        });
        $$('.panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== seg.dataset.tab; });
        if (seg.dataset.tab === 'variables') refreshVars();
      });
    });

    $('#vars-refresh').addEventListener('click', refreshVars);
    $('#run-all-btn').addEventListener('click', runAll);
    $('#stop-btn').addEventListener('click', stopExecution);
    $('#restart-btn').addEventListener('click', () => restartKernel(false));
    $('#clear-btn').addEventListener('click', clearAllOutputs);
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#shortcuts-btn').addEventListener('click', openShortcuts);
    $('#kernel-pill').addEventListener('click', (event) => {
      event.stopPropagation();
      openKernelPopover(event.currentTarget);
    });

    $('#menu-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      const dropdown = $('#menu-dropdown');
      dropdown.hidden = !dropdown.hidden;
    });
    $$('#menu-dropdown .menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        $('#menu-dropdown').hidden = true;
        handleMenuAction(item.dataset.action);
      });
    });

    $('#add-code-btn').addEventListener('click', () => addCellAt(state.notebook.cells.length, 'code', true));
    $('#add-md-btn').addEventListener('click', () => addCellAt(state.notebook.cells.length, 'markdown', true));

    $('#nb-title').addEventListener('input', (event) => {
      if (!state.notebook) return;
      state.notebook.title = event.target.value;
      updateMeta();
      scheduleSave();
    });
    $('#nb-title').addEventListener('blur', () => { if (state.notebook) saveNow(); });

    $('#file-input').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importIpynbFile(file);
      event.target.value = '';
    });

    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.popover') && !event.target.closest('#kernel-pill') && !event.target.closest('.type-chip')) {
        closePopovers();
      }
      if (!event.target.closest('.menu-anchor')) {
        const dropdown = $('#menu-dropdown');
        if (dropdown) dropdown.hidden = true;
      }
    });

    document.addEventListener('keydown', (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 'k' && !event.shiftKey) { event.preventDefault(); openPalette(); return; }
      if (modifier && key === 's') { event.preventDefault(); saveNow(); toast('Notebook saved', { type: 'success' }); return; }
      if (modifier && key === 'j') { event.preventDefault(); toggleTheme(); return; }
      if (modifier && key === 'b') { event.preventDefault(); toggleSidebar(); return; }
      if (event.key === 'Escape' && closeTopLayer()) { event.preventDefault(); }
    });

    window.addEventListener('resize', sizeAllEditors);
    window.addEventListener('beforeunload', () => { try { saveNow(); } catch (error) { /* ignore */ } });
  }

  function init() {
    const store = loadStore();
    state.notebooks = store;
    const currentId = localStorage.getItem(LS_CURRENT);
    let notebook = currentId && store[currentId] ? hydrateNotebook(store[currentId]) : null;
    if (!notebook) {
      notebook = welcomeNotebook();
      store[notebook.id] = serializableNotebook(notebook);
      persistStore(store);
      state.notebooks = store;
      try { localStorage.setItem(LS_CURRENT, notebook.id); } catch (error) { /* ignore */ }
    }
    state.notebook = notebook;
    state.activeCellId = notebook.cells[0] ? notebook.cells[0].id : null;

    bindEvents();
    renderNotebook();
    renderNotebookList();
    renderVars({ items: [], busy: false });
    updateKernelUI();
    updateGlobalRunning();
    setSaveState('saved');

    pollStatus();
    setInterval(pollStatus, 4000);
    setInterval(tickRunning, 120);
    setTimeout(refreshVars, 900);

    if (window.innerWidth <= 860) $('.app').classList.remove('sidebar-open');
  }

  init();
})();
