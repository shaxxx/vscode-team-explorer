// The Shelvesets tab's renderer: Visual Studio's Find
// Shelvesets and Shelveset Details, side by side. Plain script, the Source
// Control Explorer's pattern: the extension owns the state and posts all of
// it; this draws it and posts intents. Every string that came from tf goes in
// through textContent, never parsed as HTML; phase4Safety.test.ts enforces
// that, and that this posts only what shelvesetsModel.parseShelvesetsIntent
// accepts.
//
// The toolbar is built ONCE and never detached: even detaching and
// re-attaching the same input drops the caret out of it mid-word (the Source
// Control Explorer's review #1). Renders replace only the body under it, and
// the filter is applied here, on the rows the extension sent, for the same
// reason.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  const FILE_ACTIONS = ['compareUnmodified', 'compareWorkspace', 'viewShelved'];
  let state;
  let filterText = typeof saved.filter === 'string' ? saved.filter : '';
  let toolbarEl;
  let bodyEl;
  let ownerInput;
  let filterInput;
  let menuEl;
  /** The last state.owner the box was synced to; kept UNCHANGED while ownerEdited is true, so a state that repeats the same value still syncs once the user stops typing. */
  let knownOwner;
  /** Set on input, cleared when Find is posted: while true, an incoming state.owner must not overwrite what the user is typing (review #1). */
  let ownerEdited = false;

  function post(message) {
    vscode.postMessage(message);
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === undefined || value === null || value === false) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    if (children) for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  // Never disabled, only dimmed: the click still reaches the extension and
  // comes back as its own refusal message (History's D18a). `title` (when
  // given) says why while it is still dimmed, on hover -- a dimmed Delete
  // needs it read before the click, not just after.
  function button(label, className, onClick, title) {
    const b = el('button', { text: label, className: className, title: title });
    // A property, not an `el` prop: the safety test reads every `type: '...'`
    // literal in this file as a message the page can post.
    b.type = 'button';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      closeMenu();
      onClick();
    });
    return b;
  }

  function checkbox(checked, onChange, indeterminate) {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    if (indeterminate) box.indeterminate = true;
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    // A tick box sits inside a changes-table row that opens Compare on
    // dblclick (review #2): without this, the row's own handler saw the
    // second click of a double-click on the box and opened it anyway.
    box.addEventListener('dblclick', function (e) { e.stopPropagation(); });
    box.addEventListener('change', function () { onChange(!!box.checked); });
    return box;
  }

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = undefined;
    }
  }

  /** `items`: { label, allowed, message, title }. Each carries its own target, so no selection echo is awaited. */
  function openMenu(e, items) {
    closeMenu();
    menuEl = el('div', { className: 'menu', role: 'menu' }, items.map(function (it) {
      return button(it.label, it.allowed ? undefined : 'dim', function () { post(it.message); }, it.allowed ? undefined : it.title);
    }));
    menuEl.style.left = e.clientX + 'px';
    menuEl.style.top = e.clientY + 'px';
    document.body.appendChild(menuEl);
  }

  function find() {
    closeMenu();
    // The box now holds what was just sent, so the next state that confirms
    // it is free to sync again.
    ownerEdited = false;
    post({ type: 'find', owner: ownerInput.value });
  }

  /**
   * Writes a new state.owner into the box UNLESS the user is mid-edit
   * (review #1): the extension answers `ready` with its state immediately,
   * then again once the workspace's owner alias is known, so the box must
   * pick up that second value -- but never by clobbering what the user is
   * currently typing.
   */
  function syncOwner() {
    if (state.owner === knownOwner) return;
    if (ownerEdited) return; // leave knownOwner as it is, so the same value still syncs once editing stops
    knownOwner = state.owner;
    ownerInput.value = state.owner;
  }

  function buildToolbar() {
    const L = state.labels;
    ownerInput = el('input', { className: 'owner', 'aria-label': L.owner });
    ownerInput.value = state.owner;
    knownOwner = state.owner;
    ownerInput.addEventListener('input', function () { ownerEdited = true; });
    ownerInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.stopPropagation();
      find();
    });
    filterInput = el('input', { className: 'filter', 'aria-label': L.filter });
    filterInput.value = filterText;
    filterInput.addEventListener('input', function () {
      filterText = filterInput.value;
      render();
    });
    toolbarEl = el('div', { className: 'toolbar' }, [
      el('label', undefined, [el('span', { text: L.owner }), ownerInput]),
      button(L.find, undefined, find),
      el('label', undefined, [el('span', { text: L.filter }), filterInput]),
      button(L.refresh, undefined, function () { post({ type: 'refresh' }); }),
    ]);
    bodyEl = el('div', { className: 'body' });
    app.replaceChildren(toolbarEl, bodyEl);
  }

  function visibleRows() {
    const f = filterText.trim().toLowerCase();
    if (f === '') return state.rows;
    return state.rows.filter(function (r) {
      return r.name.toLowerCase().indexOf(f) >= 0 || r.comment.toLowerCase().indexOf(f) >= 0;
    });
  }

  function listPane() {
    const L = state.labels;
    if (state.listState === 'loading') return el('div', { className: 'list note', text: L.loading });
    if (state.listState === 'failed') {
      return el('div', { className: 'list error' }, [
        el('p', { text: state.listError || '' }),
        button(L.retry, undefined, function () { post({ type: 'refresh' }); }),
      ]);
    }
    if (state.rows.length === 0) return el('div', { className: 'list note', text: L.none });
    const rows = visibleRows();
    if (rows.length === 0) return el('div', { className: 'list note', text: L.noMatch });
    const head = el('tr', undefined, [L.name, L.owner, L.date, L.comment].map(function (t) { return el('th', { text: t }); }));
    const body = el('tbody');
    rows.forEach(function (r) {
      const tr = el('tr', { className: r.key === state.selected ? 'selected' : undefined, 'data-path': r.key, tabindex: '0' }, [
        el('td', { className: 'name', text: r.name }),
        el('td', { text: r.owner }),
        el('td', { className: 'date', text: r.date }),
        el('td', { text: r.comment }),
      ]);
      tr.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        // Re-selecting the same shelveset would reload it (review #2): that
        // re-ticks every change and resets Preserve, throwing away the
        // user's choices for nothing -- so only a DIFFERENT row posts.
        if (r.key !== state.selected) post({ type: 'select', key: r.key });
      });
      tr.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (r.key !== state.selected) post({ type: 'select', key: r.key });
        openMenu(e, [{ label: L.delete, allowed: r.mine, message: { type: 'delete', key: r.key }, title: r.deleteTitle }]);
      });
      body.appendChild(tr);
    });
    return el('div', { className: 'list' }, [el('table', undefined, [el('thead', undefined, [head]), body])]);
  }

  function changesTable(d) {
    const L = state.labels;
    const everyTicked = d.changes.length > 0 && d.changes.every(function (c) { return c.ticked; });
    const someTicked = d.changes.some(function (c) { return c.ticked; });
    const all = checkbox(everyTicked, function (on) {
      post({ type: 'tick', paths: d.changes.map(function (c) { return c.serverPath; }), ticked: on });
    }, someTicked && !everyTicked);
    const head = el('tr', undefined, [el('th', undefined, [all]), el('th', { text: L.name }), el('th', { text: L.folder }), el('th', { text: L.change })]);
    const body = el('tbody');
    d.changes.forEach(function (c) {
      const box = checkbox(c.ticked, function (on) { post({ type: 'tick', paths: [c.serverPath], ticked: on }); });
      const tr = el('tr', { 'data-path': c.serverPath, tabindex: '0' }, [
        el('td', undefined, [box]),
        el('td', { className: 'name', text: c.name }),
        el('td', { text: c.folder }),
        el('td', { text: c.change }),
      ]);
      tr.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        post({ type: 'file', action: 'compareUnmodified', path: c.serverPath });
      });
      tr.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e, FILE_ACTIONS.map(function (a) {
          return { label: L[a], allowed: true, message: { type: 'file', action: a, path: c.serverPath } };
        }));
      });
      body.appendChild(tr);
    });
    return el('table', { className: 'changes' }, [el('thead', undefined, [head]), body]);
  }

  function detailsPane() {
    const L = state.labels;
    const d = state.details;
    if (!d) return el('div', { className: 'details note', text: L.pickOne });
    const parts = [el('h2', { text: d.name }), el('div', { className: 'meta', text: d.owner + ' · ' + d.date })];
    if (d.comment) parts.push(el('pre', { className: 'comment', text: d.comment }));
    if (d.state === 'loading') parts.push(el('div', { className: 'note', text: L.loading }));
    else if (d.state === 'failed') {
      parts.push(el('div', { className: 'error' }, [
        el('p', { text: d.error || '' }),
        button(L.retry, undefined, function () { post({ type: 'select', key: d.key }); }),
      ]));
    } else parts.push(changesTable(d));
    const canUnshelve = d.state === 'ok' && !d.busy && d.changes.some(function (c) { return c.ticked; });
    const preserve = checkbox(d.preserve, function (on) { post({ type: 'preserve', value: on }); });
    parts.push(el('div', { className: 'actions' }, [
      button(d.busy ? L.working : L.unshelve, canUnshelve ? 'primary' : 'primary dim', function () { post({ type: 'unshelve' }); }),
      el('label', { className: 'check' }, [preserve, el('span', { text: L.preserve })]),
      button(L.delete, d.mine && !d.busy ? undefined : 'dim', function () { post({ type: 'delete', key: d.key }); }, d.deleteTitle),
    ]));
    return el('div', { className: 'details' }, parts);
  }

  function render() {
    const list = bodyEl.querySelector('.list');
    const listTop = list ? list.scrollTop : 0;
    const details = bodyEl.querySelector('.details');
    const detailsTop = details ? details.scrollTop : 0;
    const parts = [];
    if (state.ownerError) parts.push(el('div', { className: 'error', text: state.ownerError }));
    parts.push(el('div', { className: 'panes' }, [listPane(), detailsPane()]));
    bodyEl.replaceChildren.apply(bodyEl, parts);
    const listAfter = bodyEl.querySelector('.list');
    if (listAfter) listAfter.scrollTop = listTop;
    const detailsAfter = bodyEl.querySelector('.details');
    if (detailsAfter) detailsAfter.scrollTop = detailsTop;
    // VS Code hands this back to the serializer after a restart.
    vscode.setState({ owner: state.owner, filter: filterText, selected: state.selected });
  }

  window.addEventListener('message', function (e) {
    state = e.data;
    if (!toolbarEl) buildToolbar();
    else syncOwner();
    render();
  });
  document.addEventListener('click', function () { closeMenu(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });
  post({ type: 'ready' });
})();
