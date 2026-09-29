// The Resolve Conflicts tab's renderer. Plain script, no
// framework. Every string that came from tf -- names, folders, reasons -- is
// inserted as text, never parsed as HTML; phase5Safety.test.ts enforces that.
// It can only post the five intents conflictModel.parseConflictIntent accepts.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state;

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

  // Never disabled, only dimmed (as the History tab's D18a): a click while
  // something runs still reaches the extension, which drops it.
  function button(label, dim, onClick) {
    const b = el('button', { text: label, className: dim ? 'dim' : undefined });
    // A property, not an `el` prop: the safety test reads every `type: '...'`
    // literal in this file as a message the page can post.
    b.type = 'button';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function act(key, action) {
    post({ type: 'act', key: key, action: action });
  }

  // Visual Studio's Compare drop-down: Local and Server (the default, and
  // Enter's), Server and Base, Local and Base. They only open editors, so they
  // are never dimmed.
  const COMPARES = ['compare', 'compareServerBase', 'compareLocalBase'];
  // The row whose Compare menu is open: the page's own state, like the drop-down's.
  let menuFor = null;

  function dims(action) {
    return state.busy && COMPARES.indexOf(action) < 0;
  }

  function comparesOf(row) {
    return COMPARES.filter(function (action) { return row.actions.indexOf(action) >= 0; });
  }

  function compareButton(row) {
    if (comparesOf(row).length === 0) return [];
    return [
      button(state.labels.compareMenu + ' ▾', false, function () {
        menuFor = menuFor === row.key ? null : row.key;
        render();
      }),
    ];
  }

  function compareMenu(row) {
    if (menuFor !== row.key) return null;
    return el(
      'div',
      { className: 'menu', role: 'menu' },
      comparesOf(row).map(function (action) {
        return button(state.labels[action], false, function () {
          menuFor = null;
          act(row.key, action);
          render();
        });
      }),
    );
  }

  function rowButtons(row) {
    if (row.merging) {
      return [
        el('span', { className: 'hint', text: state.mergingHint }),
        button(state.labels.resolved, state.busy, function () { act(row.key, 'resolved'); }),
        button(state.labels.cancelMerge, false, function () { act(row.key, 'cancelMerge'); }),
      ].concat(compareButton(row));
    }
    return compareButton(row).concat(
      row.actions
        .filter(function (action) { return COMPARES.indexOf(action) < 0; })
        .map(function (action) {
          return button(state.labels[action], dims(action), function () { act(row.key, action); });
        }),
    );
  }

  function renderRow(row) {
    const div = el(
      'div',
      { className: 'row' + (row.key === state.selected ? ' selected' : ''), 'data-path': row.key, tabindex: '0' },
      [
        el('div', { className: 'name', text: row.name }),
        el('div', { className: 'folder', text: row.folder }),
        el('div', { className: 'reason', text: row.reason }),
        row.versions ? el('div', { className: 'versions', text: row.versions }) : null,
        el('div', { className: 'actions' }, rowButtons(row)),
        compareMenu(row),
      ],
    );
    div.addEventListener('click', function () {
      state.selected = row.key;
      post({ type: 'select', key: row.key });
      render();
    });
    div.addEventListener('keydown', function (e) {
      // Enter on a button inside the row is that button's own click.
      if (e.target !== div) return;
      if (e.key === 'Enter' && row.actions.indexOf('compare') >= 0) act(row.key, 'compare');
    });
    return div;
  }

  function render() {
    if (!state) return;
    // Every render rebuilds the rows, dropping the focused one; a row that had
    // focus gets it back, so Enter keeps working after a click or an update.
    const active = document.activeElement;
    const focusedKey = active && active.getAttribute ? active.getAttribute('data-path') : null;
    const toolbar = el('div', { className: 'toolbar' }, [
      button(state.toolbar.refresh, state.busy, function () { post({ type: 'refresh' }); }),
      button(state.toolbar.autoMergeAll, state.busy || state.rows.length === 0, function () { post({ type: 'autoMergeAll' }); }),
    ]);
    const children = [el('h1', { text: state.title }), toolbar];
    if (state.rows.length === 0) children.push(el('p', { className: 'empty', text: state.empty }));
    for (const row of state.rows) children.push(renderRow(row));
    app.replaceChildren.apply(app, children);
    if (focusedKey !== null) {
      for (const node of app.querySelectorAll('.row')) {
        if (node.getAttribute('data-path') === focusedKey) {
          node.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menuFor !== null) {
      menuFor = null;
      render();
    }
  });

  window.addEventListener('message', function (e) {
    state = e.data;
    render();
  });
  post({ type: 'ready' });
})();
