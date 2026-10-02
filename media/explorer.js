// The Source Control Explorer's renderer. Plain
// script, no framework: the History tab's pattern. The extension owns the
// state and posts all of it; this only draws it and posts intents. Every
// string that came from tf is inserted as a Text node or through
// textContent, never parsed as HTML; phase3Part2Safety.test.ts enforces that,
// and that this posts only the intents explorerModel.parseExplorerIntent
// accepts.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state;
  /**
   * { x, y, forPath } for a selection menu (a grid row's right-click), or
   * { x, y, folder: true } for a tree folder's right-click (review #4) --
   * kept across render() so the menu survives the state echo.
   */
  let menuAt;
  let menuEl;
  /**
   * The dialog's DOM, mounted as a sibling of #app in <body> and kept alive
   * across render() while the host's `rev` is unchanged (review #1): a
   * render that so much as detaches and reattaches the same node drops
   * keyboard focus out of the Value input and closes an open <select> in a
   * real browser.
   */
  let dialogEl;
  let dialogRev;
  /**
   * The serverPath a Shift-click range starts from -- a path, not a row
   * index (review #3): a re-sort or a reorder would otherwise silently
   * repoint a remembered index at the wrong row, and that wrong range would
   * reach Undo, Check Out and Get.
   */
  let anchor;

  const MENU = ['getLatest', 'getSpecific', 'checkout', 'undo', 'history', 'compare', 'view', 'annotate', 'addItems', 'rename', 'delete', 'map', 'copyPath'];
  const COLUMNS = ['name', 'pending', 'user', 'latest', 'lastCheckIn'];
  const KINDS = ['changeset', 'date', 'label', 'latest', 'workspace'];

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

  // History's D18a: an action is NEVER disabled, only dimmed -- its click
  // still reaches the extension and comes back as the model's own refusal
  // message instead of silently doing nothing.
  function button(label, className, onClick) {
    const b = el('button', { text: label, className: className });
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

  function dimUnless(list, action) {
    return list.indexOf(action) >= 0 ? undefined : 'dim';
  }

  function selected(path) {
    return state.selection.indexOf(path) >= 0;
  }

  function toolbar() {
    const L = state.labels;
    const crumbs = el('span', { className: 'crumbs' });
    state.crumbs.forEach(function (c, i) {
      if (i > 0) crumbs.appendChild(el('span', { className: 'sep', text: ' › ' }));
      const link = el('button', { className: 'crumb', text: c.name });
      link.type = 'button';
      link.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        post({ type: 'navigate', path: c.path });
      });
      crumbs.appendChild(link);
    });
    const allowed = state.folderAllowed;
    return el('div', { className: 'toolbar' }, [
      crumbs,
      el('span', { className: 'actions' }, [
        button(L.refresh, undefined, function () { post({ type: 'refresh' }); }),
        button(L.getLatest, dimUnless(allowed, 'getLatest'), function () { post({ type: 'action', action: 'getLatest', paths: [] }); }),
        button(L.getSpecific, dimUnless(allowed, 'getSpecific'), function () { post({ type: 'action', action: 'getSpecific', paths: [] }); }),
        button(L.history, dimUnless(allowed, 'history'), function () { post({ type: 'action', action: 'history', paths: [] }); }),
      ]),
    ]);
  }

  function tree() {
    const box = el('div', { className: 'tree', role: 'tree' });
    state.tree.forEach(function (t) {
      const twisty = el('span', { className: 'twisty', text: t.loading ? '…' : t.expanded ? '▾' : '▸' });
      twisty.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        post({ type: 'toggle', path: t.path });
      });
      const node = el('div', { className: t.current ? 'node current' : 'node', role: 'treeitem', 'data-path': t.path }, [
        twisty,
        el('span', { className: t.added ? 'label added' : 'label', text: t.name }),
      ]);
      node.style.paddingLeft = 4 + t.depth * 14 + 'px';
      node.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        post({ type: 'navigate', path: t.path });
      });
      // Review #4: Visual Studio's own behaviour for a tree folder's
      // right-click -- navigate there first (the same intent a left-click
      // posts; the host applies messages in order), then open the SAME menu
      // the toolbar's folder actions use, with folderAllowed and paths: []
      // meaning "the folder just opened".
      node.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openFolderMenu(t.path, e);
      });
      box.appendChild(node);
    });
    return box;
  }

  function statusCell(loadState, text) {
    if (loadState === 'loading') return '…';
    if (loadState === 'failed') return state.labels.unavailable;
    return text;
  }

  function latestText(r) {
    const L = state.labels;
    if (r.latest === 'notMapped') return L.notMapped;
    if (state.infoState === 'loading') return '…';
    if (state.infoState === 'failed' || r.latest === 'unknown') return L.unavailable;
    if (r.latest === 'yes') return L.yes;
    if (r.latest === 'no') return L.no;
    return L.notDownloaded;
  }

  function clickRow(index, e) {
    const path = state.rows[index].serverPath;
    // Resolve the anchor's path against the CURRENT rows at click time
    // (review #3) -- never a remembered index, which a re-sort or a reorder
    // would silently repoint at the wrong row. Not found (e.g. never set)
    // falls through to a plain click.
    const anchorIndex = anchor === undefined ? -1 : state.rows.findIndex(function (r) { return r.serverPath === anchor; });
    let next;
    if (e.shiftKey && anchorIndex >= 0) {
      const a = Math.min(anchorIndex, index);
      const b = Math.max(anchorIndex, index);
      next = state.rows.slice(a, b + 1).map(function (r) { return r.serverPath; });
    } else if (e.ctrlKey || e.metaKey) {
      next = selected(path)
        ? state.selection.filter(function (p) { return p !== path; })
        : state.selection.concat([path]);
      anchor = path;
    } else {
      next = [path];
      anchor = path;
    }
    post({ type: 'select', paths: next });
  }

  function grid() {
    const L = state.labels;
    if (state.listState === 'loading') return el('div', { className: 'note', text: L.loading });
    if (state.listState === 'failed') {
      return el('div', { className: 'error' }, [
        el('p', { text: state.listError || '' }),
        button(L.retry, undefined, function () { post({ type: 'refresh' }); }),
      ]);
    }
    if (state.rows.length === 0) return el('div', { className: 'note', text: L.empty });
    const head = el('tr', undefined, COLUMNS.map(function (c) {
      const arrow = state.sort.key === c ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      const th = el('th', { text: L[c] + arrow });
      th.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        post({ type: 'sort', key: c });
      });
      return th;
    }));
    const body = el('tbody');
    state.rows.forEach(function (r, index) {
      const tr = el('tr', { className: selected(r.serverPath) ? 'selected' : undefined, 'data-path': r.serverPath, tabindex: '0' }, [
        el('td', { className: (r.isFolder ? 'name folder' : 'name') + (r.added ? ' added' : ''), text: r.name }),
        el('td', { text: statusCell(state.statusState, r.pending) }),
        el('td', { text: statusCell(state.statusState, r.users.join(', ')), title: r.userDetails.join('\n') || undefined }),
        el('td', { className: 'latest-' + r.latest, text: latestText(r) }),
        el('td', { text: statusCell(state.infoState, r.lastCheckIn) }),
      ]);
      tr.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        clickRow(index, e);
      });
      tr.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        post({ type: 'action', action: 'open', paths: [r.serverPath] });
      });
      tr.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openMenu(index, e);
      });
      body.appendChild(tr);
    });
    return el('div', { className: 'grid' }, [
      el('table', undefined, [el('thead', undefined, [head]), body]),
      el('div', { className: 'footer', text: state.footer }),
    ]);
  }

  function openMenu(index, e) {
    const path = state.rows[index].serverPath;
    if (!selected(path)) {
      anchor = path;
      post({ type: 'select', paths: [path] });
    }
    menuAt = { x: e.clientX, y: e.clientY, forPath: path };
    buildMenu();
  }

  /**
   * Review #4: the tree folder equivalent of `openMenu` -- there is no row
   * selection to fall back on, so the menu always shows immediately, for
   * `path`, using the folder-level allowed list and `paths: []` (the
   * toolbar's own convention for "the folder that is now open").
   */
  function openFolderMenu(path, e) {
    post({ type: 'navigate', path: path });
    menuAt = { x: e.clientX, y: e.clientY, folder: true };
    buildMenu();
  }

  function closeMenu() {
    menuAt = undefined;
    if (menuEl) {
      menuEl.remove();
      menuEl = undefined;
    }
  }

  /**
   * (Re)builds the menu from `menuAt`. Runs from openMenu/openFolderMenu and
   * at the end of every render(): a right-click on an unselected row first
   * posts `select`, and the menu appears once the extension echoes that
   * selection back -- it always acts on the selection the extension knows.
   */
  function buildMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = undefined;
    }
    if (!menuAt || !state) return;
    if (!menuAt.folder && !selected(menuAt.forPath)) return;
    const L = state.labels;
    const isFolder = !!menuAt.folder;
    const paths = isFolder ? [] : state.selection.slice();
    const allowedList = isFolder ? state.folderAllowed : state.allowed;
    const items = MENU.map(function (action) {
      return button(L[action], dimUnless(allowedList, action), function () {
        post({ type: 'action', action: action, paths: paths });
      });
    });
    // A folder's menu offers everything the toolbar does, Refresh included
    // (user, 2026-09-23): the toolbar acts on this same folder, so the two
    // must not disagree. Refresh is not an action on items, so it is the
    // page's own intent rather than one of MENU's.
    if (isFolder) {
      items.unshift(button(L.refresh, undefined, function () { post({ type: 'refresh' }); }));
    }
    menuEl = el('div', { className: 'menu', role: 'menu' }, items);
    menuEl.style.left = menuAt.x + 'px';
    menuEl.style.top = menuAt.y + 'px';
    document.body.appendChild(menuEl);
  }

  /** Builds a fresh dialog overlay from `d`. Pure: mounting is syncDialog's job. */
  function buildDialog(d) {
    const L = state.labels;
    const names = { changeset: L.gsvChangeset, date: L.gsvDate, label: L.gsvLabel, latest: L.gsvLatest, workspace: L.gsvWorkspace };
    const kind = el('select', { className: 'kind' }, KINDS.map(function (k) {
      return el('option', { value: k, text: names[k] });
    }));
    kind.value = d.request.kind;
    const value = el('input', { className: 'value' });
    value.value = d.request.value;
    const hint = el('div', { className: 'hint' });
    const writable = el('input');
    writable.type = 'checkbox';
    writable.checked = d.request.overwriteWritable;
    const all = el('input');
    all.type = 'checkbox';
    all.checked = d.request.getAll;
    function read() {
      return { kind: kind.value, value: value.value, overwriteWritable: !!writable.checked, getAll: !!all.checked };
    }
    const pick = button(L.gsvPick, undefined, function () { post({ type: 'pickChangeset', request: read() }); });
    function sync() {
      const k = kind.value;
      value.style.display = k === 'latest' || k === 'workspace' ? 'none' : '';
      pick.style.display = k === 'changeset' ? '' : 'none';
      hint.textContent = k === 'date' ? L.gsvDateHint : '';
      value.setAttribute('placeholder', k === 'date' ? 'YYYY-MM-DD' : '');
    }
    kind.addEventListener('change', sync);
    sync();
    const form = el('div', { className: 'dialog', role: 'dialog' }, [
      el('h3', { text: L.gsvTitle }),
      el('div', { className: 'what', text: d.what }),
      el('label', undefined, [el('span', { text: L.gsvType }), kind]),
      el('label', undefined, [el('span', { text: L.gsvValue }), value, pick]),
      hint,
      el('label', { className: 'check' }, [writable, el('span', { text: L.gsvOverwriteWritable })]),
      el('label', { className: 'check' }, [all, el('span', { text: L.gsvGetAll })]),
      d.error ? el('div', { className: 'error', text: d.error }) : undefined,
      el('div', { className: 'buttons' }, [
        button(L.cancel, undefined, function () { post({ type: 'closeDialog' }); }),
        button(L.gsvGet, 'primary', function () { post({ type: 'submitDialog', request: read() }); }),
      ]),
    ]);
    form.addEventListener('click', function (e) { e.stopPropagation(); });
    return el('div', { className: 'overlay' }, [form]);
  }

  /**
   * Mounts the dialog as a sibling of #app in <body>, outside render()'s
   * replaceChildren (review #1). A render with the SAME `rev` leaves this
   * DOM completely untouched: a background post (a detail load, a status
   * refresh, a change event) can arrive while the dialog is open, and even
   * detaching and reattaching the identical node drops focus out of the
   * Value input and closes an open <select> in a real browser.
   */
  function syncDialog() {
    const d = state.dialog;
    if (!d) {
      if (dialogEl) dialogEl.remove();
      dialogEl = undefined;
      dialogRev = undefined;
      return;
    }
    if (dialogEl && dialogRev === d.rev) return;
    if (dialogEl) dialogEl.remove();
    dialogEl = buildDialog(d);
    dialogRev = d.rev;
    document.body.appendChild(dialogEl);
  }

  function render() {
    const beforeGrid = app.querySelector('.grid');
    const gridTop = beforeGrid ? beforeGrid.scrollTop : 0;
    // Review #2: the tree pane keeps its scroll position the same way the
    // grid does -- History restores both of its panes for the same reason.
    const beforeTree = app.querySelector('.tree');
    const treeTop = beforeTree ? beforeTree.scrollTop : 0;
    app.replaceChildren(toolbar(), el('div', { className: 'panes' }, [tree(), el('div', { className: 'right' }, [grid()])]));
    const afterGrid = app.querySelector('.grid');
    if (afterGrid) afterGrid.scrollTop = gridTop;
    const afterTree = app.querySelector('.tree');
    if (afterTree) afterTree.scrollTop = treeTop;
    syncDialog();
    buildMenu();
    // VS Code hands this back to the serializer after a restart.
    vscode.setState({ path: state.path });
  }

  window.addEventListener('message', function (e) {
    state = e.data;
    render();
  });
  document.addEventListener('click', function () { closeMenu(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (menuEl) closeMenu();
    else if (state && state.dialog) post({ type: 'closeDialog' });
  });
  post({ type: 'ready' });
})();
