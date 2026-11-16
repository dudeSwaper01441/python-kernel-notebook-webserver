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
