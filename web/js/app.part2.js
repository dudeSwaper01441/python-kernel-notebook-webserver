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
