// The History tab's renderer. Plain script, no framework.
// Every string that came from tf is inserted as a Text node or through
// textContent, never parsed as HTML; phase2Safety.test.ts enforces that.
// It can only post the six intents historyModel.parseIntent accepts.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state;
  /** D16b: { id, x, y } of the open menu, kept across render() so it survives the state echo. */
  let menuState;
  /** The menu's own DOM node, rebuilt on every render(). */
  let menuEl;

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

  // D18a: an action button is NEVER disabled -- a refusable action (a
  // different name, a renamed item, a deleted version, an add row, a folder
  // row...) only gets the 'dim' class, so its click still reaches the
  // extension and comes back as the model's own refusal message instead of
  // silently doing nothing.
  function button(label, enabled, onClick) {
    const b = el('button', { text: label, className: enabled ? undefined : 'dim' });
    // A property, not an `el` prop: the safety test reads every `type: '...'`
    // literal in this file as a message the page can post.
    b.type = 'button';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      closeMenu();
      onClick();
      // D18e: after a menu action, Load more, or any other button here,
      // focus lands back on the selected row rather than nowhere.
      focusSelectedRow();
    });
    return b;
  }

  /** D18e: after Escape, a menu action or Load more, focus returns to the selected row. */
  function focusSelectedRow() {
    if (!state) return;
    const target = state.selected === undefined
      ? app.querySelector('tr[tabindex="0"]')
      : app.querySelector('tr[data-id="' + state.selected + '"]');
    // D20a: `preventScroll` -- this row is already on screen (that is why it
    // was selectable), so a native focus-driven scroll here only ever
    // undoes whatever scroll position render() just restored (the Load more
    // bug: it jumped the grid back to the top).
    if (target && target.focus) target.focus({ preventScroll: true });
  }

  function rowActions(row) {
    const L = state.labels;
    return [
      button(L.compare, row.canCompare, function () { post({ type: 'compare', id: row.id }); }),
      button(L.view, row.canView, function () { post({ type: 'view', id: row.id }); }),
      button(L.getVersion, row.canGet, function () { post({ type: 'getVersion', id: row.id }); }),
    ];
  }

  /** Removes the menu's DOM node without forgetting it should reopen (D16b). */
  function removeMenuEl() {
    if (menuEl) {
      menuEl.remove();
      menuEl = undefined;
    }
  }

  /** A real close: Escape, a click outside, an action picked, or the row going away. */
  function closeMenu() {
    menuState = undefined;
    removeMenuEl();
  }

  /**
   * (Re)builds the menu's DOM node from `menuState`, if any. Called both from
   * `openMenu` and from the end of every `render()` (D16b): a right-click
   * posts `select`, the extension echoes state, `render()` rebuilds the whole
   * page, and without this the menu -- which `render()` had thrown away along
   * with everything else -- would vanish the instant it opened.
   *
   * D20d: a rebuild throws the old menu's DOM node away, taking real keyboard
   * focus with it if it was there -- unlike D18e's "don't steal focus back on
   * an unrelated update" (focus was on the GRID then, not the menu), losing
   * focus to nowhere because the element it was on got removed out from under
   * it is never desired, so the new menu gets it back in that case only.
   */
  function buildMenu() {
    const hadFocus = !!(menuEl && document.activeElement && menuEl.contains(document.activeElement));
    removeMenuEl();
    if (!menuState || !state || state.mode !== 'file') {
      menuState = undefined;
      return;
    }
    const row = rowById(menuState.id);
    if (!row) {
      // The row this menu was for is no longer listed: nothing sensible to reopen.
      menuState = undefined;
      return;
    }
    menuEl = el('div', { className: 'menu', role: 'menu' }, rowActions(row));
    menuEl.style.left = menuState.x + 'px';
    menuEl.style.top = menuState.y + 'px';
    document.body.appendChild(menuEl);
    if (hadFocus) {
      const first = menuEl.querySelector('button:not([disabled])');
      if (first) first.focus({ preventScroll: true });
    }
  }

  // D18e: focus moves into the menu once, right when it opens -- `buildMenu()`
  // above also runs at the end of every `render()` (D16b, so the menu survives
  // the state echo), and focusing it there too would steal focus back on
  // every unrelated state update while it happens to be open (D20d handles
  // that rebuild case on its own, only when the OLD menu already had focus).
  function openMenu(x, y, row) {
    menuState = { id: row.id, x: x, y: y };
    buildMenu();
    const first = menuEl && menuEl.querySelector('button:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }

  function select(id) {
    if (!state) return;
    // Already selected AND its details are in hand: nothing to do. Otherwise
    // -- still loading, or a previous attempt failed -- fall through and post
    // again, which is how reselecting the same row retries (D16d).
    if (state.selected === id && state.details && state.details.id === id) return;
    state.selected = id; // highlight now; the extension's state follows
    render();
    post({ type: 'select', id: id });
  }

  function rowById(id) {
    return state.rows.find(function (r) { return r.id === id; });
  }

  function onKey(e) {
    if (!state || state.rows.length === 0) return;
    const i = state.rows.findIndex(function (r) { return r.id === state.selected; });
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(state.rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
      const id = state.rows[next].id;
      select(id);
      // D20a: the focus() that lands on this row (in render(), via select())
      // now uses preventScroll, so holding an arrow key past the edge of the
      // visible grid would otherwise leave the newly-selected row off screen
      // with no way to see it moved -- scroll it into view explicitly instead.
      const tr = app.querySelector('tr[data-id="' + id + '"]');
      if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && i >= 0) {
      // D18a: posted regardless of canCompare -- a refusable row answers with
      // the model's own message instead of Enter silently doing nothing.
      post({ type: 'compare', id: state.rows[i].id });
    } else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && i >= 0) {
      e.preventDefault();
      const tr = app.querySelector('tr[data-id="' + state.rows[i].id + '"]');
      const rect = tr ? tr.getBoundingClientRect() : { left: 0, bottom: 0 };
      openMenu(rect.left + 20, rect.bottom, state.rows[i]);
    }
  }

  function grid() {
    const L = state.labels;
    const body = el('tbody');
    state.rows.forEach(function (row, index) {
      const selected = row.id === state.selected;
      // D16e: with nothing selected, the grid still needs ONE tab stop, or
      // Tab skips over it entirely -- the first row takes that role.
      const tabbable = selected || (state.selected === undefined && index === 0);
      const tr = el(
        'tr',
        {
          className: selected ? 'selected' : undefined,
          tabindex: tabbable ? 0 : -1,
          'aria-selected': selected ? 'true' : 'false',
          title: row.comment,
          'data-id': row.id,
        },
        [
          el('td', { className: 'id', text: String(row.id) }),
          el('td', { className: 'user', text: row.user }),
          el('td', { className: 'date', text: row.date }),
          el('td', { className: 'comment', text: row.firstLine }),
        ],
      );
      tr.addEventListener('click', function () { select(row.id); });
      tr.addEventListener('dblclick', function () {
        // D18a: posted regardless of canCompare, same as the button and Enter.
        post({ type: 'compare', id: row.id });
      });
      tr.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        select(row.id);
        openMenu(e.clientX, e.clientY, row);
      });
      body.appendChild(tr);
    });
    const head = el('thead', null, [
      el('tr', null, [
        el('th', { className: 'id', text: L.changeset }),
        el('th', { className: 'user', text: L.user }),
        el('th', { className: 'date', text: L.date }),
        el('th', { text: L.comment }),
      ]),
    ]);
    const table = el('table', { className: 'grid', role: 'grid' }, [head, body]);
    table.addEventListener('keydown', onKey);
    return el('div', { className: 'grid-wrap' }, [table]);
  }

  function detailsPane() {
    const L = state.labels;
    const pane = el('section', { className: 'details' });
    const row = state.selected === undefined ? undefined : rowById(state.selected);
    if (!row) {
      pane.appendChild(el('p', { className: 'hint', text: L.selectPrompt }));
      return pane;
    }
    if (state.mode === 'file') pane.appendChild(el('div', { className: 'actions' }, rowActions(row)));
    pane.appendChild(el('h2', { text: L.details + ' ' + row.id }));
    pane.appendChild(el('p', { className: 'meta', text: row.user + ' · ' + row.date }));
    pane.appendChild(el('pre', { className: 'comment', text: row.comment }));
    const d = state.details;
    if (!d || d.id !== row.id) {
      // D16d/D18c: a failed fetch must not leave this pane reading "Loading…"
      // forever. `state.detailsError` is the details pane's OWN field, kept
      // apart from the page banner (`state.error`), so a page-level failure
      // elsewhere never bleeds into this pane and vice versa; reselecting the
      // row retries.
      const failed = !state.loading && state.detailsError;
      pane.appendChild(
        el('p', {
          className: failed ? 'error' : 'hint',
          role: failed ? 'alert' : undefined,
          text: failed ? state.detailsError : L.loading,
        }),
      );
      return pane;
    }
    const body = el('tbody');
    for (const item of d.items) {
      body.appendChild(
        el('tr', null, [
          el('td', { className: 'change', text: item.change }),
          el('td', { className: 'path', text: item.path }),
          el('td', { className: 'item-actions' }, [
            button(L.compare, item.canCompare, function () { post({ type: 'compare', id: d.id, item: item.index }); }),
            button(L.view, true, function () { post({ type: 'view', id: d.id, item: item.index }); }),
          ]),
        ]),
      );
    }
    pane.appendChild(
      el('table', { className: 'items' }, [
        el('thead', null, [el('tr', null, [el('th', { text: L.change }), el('th', { text: L.path }), el('th')])]),
        body,
      ]),
    );
    if (d.note) pane.appendChild(el('p', { className: 'hint', text: d.note }));
    return pane;
  }

  function render() {
    if (!state) {
      removeMenuEl();
      return;
    }
    const L = state.labels;
    // D16e: `replaceChildren` below throws away the grid and details DOM
    // nodes along with their scroll position; carry it over by hand.
    const oldGridWrap = app.querySelector('.grid-wrap');
    const gridScroll = oldGridWrap ? oldGridWrap.scrollTop : 0;
    const oldDetails = app.querySelector('.details');
    const detailsScroll = oldDetails ? oldDetails.scrollTop : 0;
    const hadFocus = document.activeElement && document.activeElement.tagName === 'TR';
    const parts = [el('h1', { text: state.title })];
    if (state.error) parts.push(el('p', { className: 'error', role: 'alert', text: state.error }));
    parts.push(grid());
    const footer = el('div', { className: 'footer' });
    if (state.loading) footer.appendChild(el('span', { className: 'hint', text: L.loading }));
    else if (state.more) footer.appendChild(button(L.loadMore, true, function () { post({ type: 'loadMore' }); }));
    if (state.empty) footer.appendChild(el('span', { className: 'hint', text: L.empty }));
    parts.push(footer);
    parts.push(detailsPane());
    app.replaceChildren.apply(app, parts);
    const newGridWrap = app.querySelector('.grid-wrap');
    if (newGridWrap) newGridWrap.scrollTop = gridScroll;
    const newDetails = app.querySelector('.details');
    if (newDetails) newDetails.scrollTop = detailsScroll;
    const current = app.querySelector('tr[tabindex="0"]');
    // D20a: preventScroll -- this re-render already restored the grid's own
    // scroll position above; a plain focus() here would override that (the
    // Load more bug: clicking it re-renders with the row still selected,
    // and an un-flagged focus() snapped the grid back to the top).
    if (current && hadFocus) current.focus({ preventScroll: true });
    // D16b: reopen the menu for the same row at the same place, if it is
    // still listed -- this rebuild just threw away its DOM node too.
    buildMenu();
  }

  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeMenu();
      // D18e: Escape returns focus to the selected row, same as a menu action.
      focusSelectedRow();
    }
  });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'state') {
      const previousSelected = state ? state.selected : undefined;
      state = message.state;
      render();
      // D16e: a selection change that came from the EXTENSION (Annotate's
      // "Changeset details" hover, select-until-found) may land on a row the
      // user never scrolled to, unlike a click, which is already in view.
      if (state.selected !== undefined && state.selected !== previousSelected) {
        const tr = app.querySelector('tr[data-id="' + state.selected + '"]');
        if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
      }
    }
  });
  post({ type: 'ready' });
})();
