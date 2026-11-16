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
