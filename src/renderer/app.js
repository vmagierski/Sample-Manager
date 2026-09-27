'use strict';

const ROW_H = 30;
const OVERSCAN = 8;
const CACHE_SIZE = 12; // decoded AudioBuffers kept for instant re-audition

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const ui = {
  back: $('#back'),
  random: $('#random'),
  rec: $('#rec'),
  recall: $('#recall'),
  flash: $('#flash'),
  fwd: $('#fwd'),
  foldersMenu: $('#folders-menu'),
  clearFolders: $('#clear-folders'),
  search: $('#search'),
  status: $('#status'),
  count: $('#count'),
  collapse: $('#collapse'),
  folders: $('#folders'),
  tags: $('#tags'),
  clearTags: $('#clear-tags'),
  list: $('#list'),
  spacer: $('#spacer'),
  rows: $('#rows'),
  empty: $('#empty'),
  play: $('#play'),
  nowName: $('#now-name'),
  wave: $('#wave'),
  time: $('#time'),
  autoplay: $('#autoplay'),
  volume: $('#volume'),
};

const state = {
  rows: [],
  total: 0,
  folders: [],
  tagCounts: [],
  untaggedCount: 0,
  filter: { search: '', tags: new Set(), untagged: false, dirs: new Set() },
  dirs: [], // [{ folderId, dir, n }] — directories that directly hold samples
  tree: [], // root nodes: { path, name, n, total, kids: Map, folder }
  hidden: new Set(), // hidden folder paths
  expanded: loadExpanded(), // dir paths open in the folder tree
  selected: new Set(), // sample ids
  cursor: -1,
  anchor: -1,
  editing: null, // { id, value }
  rendered: { start: -1, end: -1, version: -1 },
  version: 0, // bumps whenever rows change, forcing a list rebuild
};

// --- helpers --------------------------------------------------------------

function hue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

function fmtDuration(ms) {
  return ms == null ? '' : fmtTime(ms / 1000);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// --- data loading ---------------------------------------------------------

let listSeq = 0;
// opts.reset: the user changed the view — if the current sample isn't in the
//   new results, start at the top instead of wherever the old index lands.
// opts.restore: a history snapshot — put selection and scroll back exactly.
async function refreshList(opts = {}) {
  const seq = ++listSeq;
  const { restore, reset } = opts;
  const cursorId = restore ? restore.cursorId : state.rows[state.cursor]?.id;
  const { filter } = state;
  const res = await window.sm.listSamples({
    search: filter.search,
    tags: [...filter.tags],
    untagged: filter.untagged,
    dirs: [...filter.dirs],
  });
  if (seq !== listSeq) return; // a newer query superseded this one

  state.rows = res.rows;
  state.total = res.total;
  const ids = new Set(res.rows.map((r) => r.id));
  if (restore) state.selected = new Set(restore.selected.filter((id) => ids.has(id)));
  else for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
  const idx = cursorId != null ? res.rows.findIndex((r) => r.id === cursorId) : -1;
  if (idx >= 0) state.cursor = idx;
  else if (reset || restore) state.cursor = res.rows.length ? 0 : -1;
  else state.cursor = res.rows.length ? clamp(state.cursor, 0, res.rows.length - 1) : -1;
  if (state.cursor >= 0 && !state.selected.size) state.selected.add(res.rows[state.cursor].id);
  state.anchor = state.cursor;
  if (state.editing && !ids.has(state.editing.id)) state.editing = null;
  state.version++;

  renderCount();
  renderEmpty();
  ui.spacer.style.height = `${res.rows.length * ROW_H}px`; // so the scrollTop below isn't clamped
  if (restore) ui.list.scrollTop = restore.scrollTop;
  else if (reset) {
    if (idx >= 0) ensureVisible(idx);
    else ui.list.scrollTop = 0;
  }
  renderList();
}

// --- back / forward ---------------------------------------------------------------
//
// A history entry is a whole "place": filters, selected sample(s), scroll.
// Recorded on view changes (folder, tag, search) and on clicking a sample —
// not on arrow-key browsing, which would bury real places under every step.

const nav = { back: [], fwd: [], lastKind: null, lastAt: 0 };
const NAV_MAX = 100;

function snapshot() {
  const f = state.filter;
  return {
    filter: { search: f.search, tags: [...f.tags], untagged: f.untagged, dirs: [...f.dirs] },
    cursorId: state.rows[state.cursor]?.id ?? null,
    selected: [...state.selected],
    scrollTop: ui.list.scrollTop,
  };
}

function recordNav(kind) {
  const now = Date.now();
  // Typing a search is one step, not one per debounced keystroke.
  const coalesce = kind === 'search' && nav.lastKind === 'search' && now - nav.lastAt < 1500;
  nav.lastKind = kind;
  nav.lastAt = now;
  if (coalesce) return;
  nav.back.push(snapshot());
  if (nav.back.length > NAV_MAX) nav.back.shift();
  nav.fwd = [];
  renderNav();
}

// Record the current place, apply a filter change, reload.
function changeView(kind, mutate) {
  recordNav(kind);
  mutate();
  renderRail();
  refreshList({ reset: true });
}

async function goNav(step) {
  const from = step < 0 ? nav.back : nav.fwd;
  const to = step < 0 ? nav.fwd : nav.back;
  if (!from.length) return;
  to.push(snapshot());
  const snap = from.pop();
  nav.lastKind = null;
  if (state.editing) cancelEdit();
  const f = snap.filter;
  state.filter = { search: f.search, tags: new Set(f.tags), untagged: f.untagged, dirs: new Set(f.dirs) };
  clearTimeout(searchTimer);
  ui.search.value = f.search;
  renderRail();
  renderNav();
  await refreshList({ restore: snap });
  const cur = state.rows[state.cursor];
  if (cur && ui.autoplay.checked && (!player.row || player.row.id !== cur.id)) playRow(cur);
}

function renderNav() {
  ui.back.disabled = !nav.back.length;
  ui.fwd.disabled = !nav.fwd.length;
}

async function refreshRail() {
  const [folders, tags, dirs, hidden] = await Promise.all([
    window.sm.listFolders(),
    window.sm.listTags(),
    window.sm.listDirs(),
    window.sm.listHidden(),
  ]);
  state.folders = folders;
  state.dirs = dirs;
  state.hidden = new Set(hidden);
  const paths = buildTree();
  state.tagCounts = tags.tags;
  state.untaggedCount = tags.untagged;
  // Drop filters that point at things that no longer exist.
  const tagNames = new Set(tags.tags.map((t) => t.name));
  let filterChanged = false;
  for (const t of state.filter.tags) {
    if (!tagNames.has(t)) {
      state.filter.tags.delete(t);
      filterChanged = true;
    }
  }
  const gone = [...state.filter.dirs].filter((d) => !paths.has(d));
  if (gone.length) {
    for (const d of gone) state.filter.dirs.delete(d);
    filterChanged = true;
  }
  renderRail();
  return filterChanged;
}

async function refreshAll() {
  await refreshRail();
  await refreshList();
}

// --- rendering: header / rail ----------------------------------------------

function renderCount() {
  const n = state.rows.length.toLocaleString();
  const t = state.total.toLocaleString();
  ui.count.textContent = state.rows.length === state.total ? `${t} samples` : `${n} of ${t} samples`;
}

function renderEmpty() {
  ui.empty.replaceChildren();
  if (state.rows.length) {
    ui.empty.hidden = true;
    return;
  }
  ui.empty.hidden = false;
  if (!state.folders.length) {
    ui.empty.append(el('div', null, 'No sample folders yet.'));
    const b = el('button', null, '+ Add a folder');
    b.addEventListener('click', addFolder);
    ui.empty.append(b);
  } else if (state.total === 0) {
    ui.empty.append(el('div', null, 'No audio files found in your folders yet.'));
  } else {
    ui.empty.append(el('div', null, 'No samples match.'));
  }
}

// --- folder tree -------------------------------------------------------------

function loadExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem('sm.expanded') || '[]'));
  } catch {
    return new Set();
  }
}

function saveExpanded() {
  try {
    localStorage.setItem('sm.expanded', JSON.stringify([...state.expanded]));
  } catch {}
}

// Builds state.tree from state.folders + state.dirs; returns the set of all node paths.
// node.n counts visible samples (hidden subfolders excluded); node.total counts all.
function buildTree() {
  const paths = new Set();
  const roots = new Map();
  for (const f of state.folders) {
    roots.set(f.id, { path: f.path, name: f.label || f.path, n: 0, total: 0, kids: new Map(), folder: f });
    paths.add(f.path);
  }
  const hidden = [...state.hidden];
  const isHidden = (p) => hidden.some((h) => p === h || p.startsWith(h + '/'));
  for (const { folderId, dir, n } of state.dirs) {
    const root = roots.get(folderId);
    if (!root) continue;
    const visible = !isHidden(dir);
    const add = (node) => {
      node.total += n;
      if (visible) node.n += n;
    };
    add(root);
    if (!dir.startsWith(root.path + '/')) continue;
    let node = root;
    for (const seg of dir.slice(root.path.length + 1).split('/')) {
      let child = node.kids.get(seg);
      if (!child) {
        child = { path: `${node.path}/${seg}`, name: seg, n: 0, total: 0, kids: new Map() };
        node.kids.set(seg, child);
        paths.add(child.path);
      }
      add(child);
      node = child;
    }
  }
  state.tree = [...roots.values()];
  // Forget expanded folders that no longer exist.
  for (const p of state.expanded) if (!paths.has(p)) state.expanded.delete(p);
  return paths;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// Search runs inside the selected folders; say so in the search box.
function renderSearchScope() {
  const dirs = [...state.filter.dirs];
  const name = (p) => {
    const root = state.folders.find((f) => f.path === p);
    return root ? root.label : p.split('/').pop();
  };
  ui.search.placeholder = !dirs.length
    ? 'Search names, folders, tags   /'
    : dirs.length === 1
      ? `Search in “${name(dirs[0])}”   /`
      : `Search in ${dirs.length} folders   /`;
}

function deselectFolders() {
  if (!state.filter.dirs.size) return;
  changeView('dir', () => state.filter.dirs.clear());
}

function collapseFolders() {
  state.expanded.clear();
  saveExpanded();
  renderFolders();
}

function renderFolders() {
  const scroll = ui.folders.scrollTop;
  ui.folders.replaceChildren();
  if (!state.tree.length) ui.folders.append(el('li', 'hint', 'No folders — ⌘O to add one'));

  const addNode = (node, depth) => {
    // A hidden folder hides its whole subtree: it can't be expanded, so its
    // subfolders don't show until you unhide it.
    const hidden = state.hidden.has(node.path);
    const expandable = node.kids.size > 0 && !hidden;
    const open = expandable && state.expanded.has(node.path);
    const li = el('li', `dir${state.filter.dirs.has(node.path) ? ' on' : ''}${hidden ? ' hidden-dir' : ''}`);
    li.style.setProperty('--d', depth);
    li.title = hidden ? `${node.path}\nHidden — right-click to unhide` : node.path;
    const tw = el('span', 'tw', expandable ? (open ? '▾' : '▸') : '');
    li.append(tw, el('span', 'name', node.name), el('span', 'n', (hidden ? node.total : node.n).toLocaleString()));
    if (node.folder) {
      const x = el('button', 'x', '×');
      x.title = 'Remove folder from library';
      x.addEventListener('mousedown', (e) => e.preventDefault());
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        window.sm.removeFolder(node.folder.id);
      });
      li.append(x);
    } else {
      li.append(el('span', 'x-space')); // keeps counts aligned with the roots' × button
    }
    tw.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!expandable) return;
      if (open) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      saveExpanded();
      renderFolders();
    });
    // Click: just this folder (click again to deselect). ⇧/⌘-click: add/remove it.
    li.addEventListener('click', (e) => {
      changeView('dir', () => {
        const dirs = state.filter.dirs;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (dirs.has(node.path)) dirs.delete(node.path);
          else dirs.add(node.path);
        } else if (dirs.size === 1 && dirs.has(node.path)) {
          dirs.clear();
        } else {
          dirs.clear();
          dirs.add(node.path);
        }
      });
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.sm.dirMenu(node.path);
    });
    ui.folders.append(li);
    if (open) for (const kid of [...node.kids.values()].sort(byName)) addNode(kid, depth + 1);
  };
  for (const root of state.tree) addNode(root, 0);

  ui.folders.scrollTop = scroll;
  ui.collapse.hidden = !state.expanded.size;
  ui.clearFolders.hidden = !state.filter.dirs.size;
  renderSearchScope();
}

function renderRail() {
  renderFolders();

  // tags
  ui.tags.replaceChildren();
  const addTagItem = (name, count, on, cls, onClick) => {
    const li = el('li', [cls, on ? 'on' : ''].filter(Boolean).join(' '));
    const dot = el('span', 'dot');
    dot.style.setProperty('--h', hue(name));
    li.append(dot, el('span', 'name', name), el('span', 'n', count.toLocaleString()));
    if (!count) li.classList.add('empty');
    li.addEventListener('click', onClick);
    if (cls !== 'untagged') {
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        window.sm.tagMenu(name);
      });
    }
    ui.tags.append(li);
  };
  for (const t of state.tagCounts) {
    addTagItem(t.name, t.count, state.filter.tags.has(t.name), '', () => {
      changeView('tag', () => {
        if (state.filter.tags.has(t.name)) state.filter.tags.delete(t.name);
        else state.filter.tags.add(t.name);
        state.filter.untagged = false; // tags are ANDed; "untagged" + a tag can never match
      });
    });
  }
  if (state.untaggedCount || state.filter.untagged) {
    addTagItem('untagged', state.untaggedCount, state.filter.untagged, 'untagged', () => {
      changeView('tag', () => {
        state.filter.untagged = !state.filter.untagged;
        if (state.filter.untagged) state.filter.tags.clear();
      });
    });
  }
  ui.clearTags.hidden = !(state.filter.tags.size || state.filter.untagged);
}

// --- rendering: virtualized list ---------------------------------------------
//
// Only the rows in view (plus overscan) exist in the DOM. The DOM is rebuilt
// only when the visible range or the data changes; selection/playing state is
// patched onto existing elements, so a row isn't swapped out from under the
// mouse between mousedown and dragstart.

function renderList(force = false) {
  const n = state.rows.length;
  ui.spacer.style.height = `${n * ROW_H}px`;
  const top = ui.list.scrollTop;
  const h = ui.list.clientHeight;
  const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const end = Math.min(n, Math.ceil((top + h) / ROW_H) + OVERSCAN);
  const r = state.rendered;
  if (!force && r.start === start && r.end === end && r.version === state.version) return;
  state.rendered = { start, end, version: state.version };

  ui.rows.style.transform = `translateY(${start * ROW_H}px)`;
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.append(buildRow(i));
  ui.rows.replaceChildren(frag);
  updateRowClasses();

  const input = ui.rows.querySelector('input.tag-input');
  if (input) input.focus();
}

function buildRow(i) {
  const r = state.rows[i];
  const row = el('div', 'row');
  row.dataset.i = i;
  row.dataset.id = r.id;
  const editing = state.editing && state.editing.id === r.id;
  row.draggable = !editing;

  const name = el('span', 'c-name', r.filename);
  name.title = r.path;
  const dir = r.relPath.slice(0, Math.max(0, r.relPath.length - r.filename.length - 1));
  if (dir) name.append(el('span', 'dir', dir));

  const tags = el('span', 'c-tags');
  if (editing) tags.append(buildTagInput(r));
  else fillChips(tags, r.tags);

  row.append(name, tags, el('span', 'c-fmt', r.format), el('span', 'c-dur', fmtDuration(r.durationMs)));
  return row;
}

function fillChips(container, tags) {
  container.replaceChildren();
  for (const t of tags) {
    const chip = el('span', 'chip', t);
    chip.style.setProperty('--h', hue(t));
    container.append(chip);
  }
  container.append(el('span', 'add', tags.length ? '+' : '+ tag'));
}

function rowEl(id) {
  return ui.rows.querySelector(`.row[data-id="${id}"]`);
}

// Update one row's cells in place (never replaces the element).
function patchRow(r) {
  const e = rowEl(r.id);
  if (!e) return;
  e.querySelector('.c-dur').textContent = fmtDuration(r.durationMs);
  if (!(state.editing && state.editing.id === r.id)) fillChips(e.querySelector('.c-tags'), r.tags);
}

function updateRowClasses() {
  const playingId = player.row?.id;
  for (const e of ui.rows.children) {
    const i = +e.dataset.i;
    const id = +e.dataset.id;
    e.classList.toggle('sel', state.selected.has(id));
    e.classList.toggle('cursor', i === state.cursor);
    e.classList.toggle('playing', id === playingId);
  }
}

function ensureVisible(i) {
  if (i < 0) return;
  const top = i * ROW_H;
  const view = ui.list.clientHeight;
  if (top < ui.list.scrollTop) ui.list.scrollTop = top;
  else if (top + ROW_H > ui.list.scrollTop + view) ui.list.scrollTop = top + ROW_H - view;
}

let scrollRaf = 0;
ui.list.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    renderList();
  });
});
new ResizeObserver(() => {
  renderList(true);
  sizeWave();
}).observe(ui.list);

// --- selection -------------------------------------------------------------------

function selectSingle(i) {
  state.selected = new Set([state.rows[i].id]);
  state.cursor = state.anchor = i;
}

function extendTo(i) {
  if (state.anchor < 0) state.anchor = i;
  const [a, b] = state.anchor < i ? [state.anchor, i] : [i, state.anchor];
  state.selected = new Set(state.rows.slice(a, b + 1).map((r) => r.id));
  state.cursor = i;
}

function toggleSel(i) {
  const id = state.rows[i].id;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.cursor = state.anchor = i;
}

function selectAll() {
  state.selected = new Set(state.rows.map((r) => r.id));
  updateRowClasses();
}

function move(delta, extend) {
  const n = state.rows.length;
  if (!n) return;
  const from = state.cursor < 0 ? (delta > 0 ? -1 : n) : state.cursor;
  const i = clamp(from + delta, 0, n - 1);
  if (extend) extendTo(i);
  else selectSingle(i);
  ensureVisible(i);
  renderList();
  updateRowClasses();
  if (ui.autoplay.checked) playRow(state.rows[i]);
}

// Rows the user is acting on: the selection if the row is part of it, else just the row.
function actionRows(i) {
  const r = state.rows[i];
  if (!state.selected.has(r.id)) return [r];
  return state.rows.filter((x) => state.selected.has(x.id));
}

// --- mouse -----------------------------------------------------------------------

let pendingCollapse = -1;

ui.rows.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('input')) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const i = +row.dataset.i;
  const id = state.rows[i].id;
  pendingCollapse = -1;

  if (e.shiftKey) {
    extendTo(i);
  } else if (e.metaKey || e.ctrlKey) {
    toggleSel(i);
  } else if (state.selected.has(id)) {
    // Might be the start of a multi-row drag: collapse on click, not mousedown.
    pendingCollapse = i;
    state.cursor = i;
  } else {
    if (i !== state.cursor) recordNav('click');
    selectSingle(i);
    playRow(state.rows[i]);
  }
  updateRowClasses();
});

ui.rows.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const i = +row.dataset.i;
  if (!state.selected.has(state.rows[i].id)) {
    selectSingle(i);
    updateRowClasses();
  }
  window.sm.sampleMenu(actionRows(i).map((r) => r.id));
});

ui.rows.addEventListener('click', (e) => {
  if (e.target.closest('input')) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const i = +row.dataset.i;
  if (pendingCollapse === i) {
    pendingCollapse = -1;
    selectSingle(i);
    updateRowClasses();
    if (!e.target.closest('.c-tags')) playRow(state.rows[i]);
  }
  if (e.target.closest('.c-tags') && !e.shiftKey && !e.metaKey && !e.ctrlKey) startEdit(i);
});

// Drag-to-DAW: the OS drag is started by the main process via startDrag().
ui.rows.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.row');
  e.preventDefault();
  if (!row) return;
  pendingCollapse = -1;
  const paths = actionRows(+row.dataset.i).map((r) => r.path);
  window.sm.startDrag(paths);
});

// --- tag editing ---------------------------------------------------------------------

function buildTagInput(r) {
  const input = el('input', 'tag-input');
  input.value = state.editing.value;
  input.placeholder = 'comma, separated, tags';
  input.spellcheck = false;
  input.addEventListener('input', () => {
    if (state.editing) state.editing.value = input.value;
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') cancelEdit();
  });
  // A scroll re-render detaches the input; only a real blur commits.
  input.addEventListener('blur', () => {
    if (input.isConnected && state.editing && state.editing.id === r.id) commitEdit();
  });
  return input;
}

function startEdit(i) {
  const r = state.rows[i];
  if (!r) return;
  if (state.editing) commitEdit();
  state.editing = { id: r.id, value: r.tags.join(', ') };
  state.cursor = i;
  ensureVisible(i);
  renderList(true);
}

function endEdit() {
  state.editing = null;
  renderList(true);
  ui.list.focus();
}

function cancelEdit() {
  endEdit();
}

async function commitEdit() {
  const edit = state.editing;
  if (!edit) return;
  endEdit();
  const row = state.rows.find((r) => r.id === edit.id);
  const tags = edit.value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const saved = await window.sm.updateTags(edit.id, tags);
    if (row) {
      row.tags = saved;
      patchRow(row);
    }
  } catch (err) {
    console.error('saving tags failed', err);
  }
}

// --- player (Web Audio) -----------------------------------------------------------------
//
// Samples are read via main (which rewraps AIFF as WAV) and decoded into
// AudioBuffers: instant restarts, precise seeking, and a waveform for free.

const player = {
  ctx: null,
  gain: null,
  src: null,
  buf: null,
  row: null,
  offset: 0,
  startTime: 0,
  playing: false,
  req: 0,
  cache: new Map(), // id -> AudioBuffer (insertion order = LRU)
  peaks: new WeakMap(),
  error: null,
};

// Graph: sources → bus → volume → speakers
//                     └──→ tap (Rec / Recall, pre-volume)
function audioCtx() {
  if (!player.ctx) {
    player.ctx = new AudioContext({ latencyHint: 'interactive' });
    player.bus = player.ctx.createGain();
    player.gain = player.ctx.createGain();
    player.gain.gain.value = +ui.volume.value;
    player.bus.connect(player.gain);
    player.gain.connect(player.ctx.destination);
    tap.ready = startTap(player.ctx);
  }
  return player.ctx;
}

async function loadBuffer(row) {
  const hit = player.cache.get(row.id);
  if (hit) {
    player.cache.delete(row.id);
    player.cache.set(row.id, hit);
    return hit;
  }
  const bytes = await window.sm.readSample(row.id);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await audioCtx().decodeAudioData(ab);
  player.cache.set(row.id, buf);
  while (player.cache.size > CACHE_SIZE) player.cache.delete(player.cache.keys().next().value);
  return buf;
}

function stopSource() {
  if (player.src) {
    player.src.onended = null;
    try {
      player.src.stop();
    } catch {}
    player.src.disconnect();
    player.src = null;
  }
}

function position() {
  if (!player.buf) return 0;
  return player.playing ? player.ctx.currentTime - player.startTime : player.offset;
}

function startAt(offset) {
  const ctx = audioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  stopSource();
  const src = ctx.createBufferSource();
  src.buffer = player.buf;
  src.connect(player.bus);
  src.onended = () => {
    if (player.src !== src) return;
    player.src = null;
    player.playing = false;
    player.offset = 0;
    renderPlayer();
  };
  src.start(0, offset);
  player.src = src;
  player.startTime = ctx.currentTime - offset;
  player.playing = true;
  renderPlayer();
  tick();
}

async function playRow(row, from = 0) {
  const req = ++player.req;
  stopSource();
  player.playing = false;
  player.row = row;
  player.buf = null;
  player.offset = 0;
  player.error = null;
  renderPlayer();
  updateRowClasses();
  let buf;
  try {
    buf = await loadBuffer(row);
  } catch (err) {
    if (req !== player.req) return;
    player.error = `Can't play ${row.filename}`;
    console.error(err);
    renderPlayer();
    return;
  }
  if (req !== player.req) return; // user already moved on
  player.buf = buf;
  startAt(from);

  if (row.durationMs == null) {
    row.durationMs = Math.round(buf.duration * 1000);
    patchRow(row);
    window.sm.setDuration(row.id, row.durationMs);
  }
}

function pause() {
  if (!player.playing) return;
  player.offset = position();
  stopSource();
  player.playing = false;
  renderPlayer();
}

function togglePlay() {
  const cur = state.rows[state.cursor];
  if (cur && (!player.row || player.row.id !== cur.id)) return playRow(cur);
  if (!player.row) return;
  if (player.playing) return pause();
  if (!player.buf) return playRow(player.row);
  startAt(player.offset >= player.buf.duration ? 0 : player.offset);
}

function stopPlayback() {
  player.req++;
  stopSource();
  player.playing = false;
  player.offset = 0;
  renderPlayer();
}

function seek(frac) {
  if (!player.buf) return;
  const t = clamp(frac, 0, 1) * player.buf.duration;
  if (player.playing) startAt(t);
  else {
    player.offset = t;
    renderPlayer();
  }
}

function tick() {
  if (!player.playing) return;
  renderPlayer();
  requestAnimationFrame(tick);
}

function renderPlayer() {
  ui.play.textContent = player.playing ? '❚❚' : '▶';
  ui.nowName.textContent = player.error || (player.row ? player.row.relPath : 'Nothing playing');
  const dur = player.buf ? player.buf.duration : 0;
  ui.time.textContent = `${fmtTime(position())} / ${fmtTime(dur)}`;
  drawWave();
}

// --- waveform -------------------------------------------------------------------------

function sizeWave() {
  const dpr = window.devicePixelRatio || 1;
  ui.wave.width = Math.max(1, Math.round(ui.wave.clientWidth * dpr));
  ui.wave.height = Math.max(1, Math.round(ui.wave.clientHeight * dpr));
  drawWave();
}

function peaksFor(buf, width) {
  const cached = player.peaks.get(buf);
  if (cached && cached.width === width) return cached.data;
  const data = new Float32Array(width * 2);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const per = buf.length / width;
  for (let x = 0; x < width; x++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(x * per);
    const b = Math.max(a + 1, Math.floor((x + 1) * per));
    const step = Math.max(1, Math.floor((b - a) / 256)); // subsample long buffers
    for (const ch of chans) {
      for (let i = a; i < b && i < ch.length; i += step) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    data[x * 2] = lo;
    data[x * 2 + 1] = hi;
  }
  player.peaks.set(buf, { width, data });
  return data;
}

function drawWave() {
  const c = ui.wave;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const mid = c.height / 2;
  if (!player.buf) {
    g.fillStyle = '#2e3138';
    g.fillRect(0, mid, c.width, 1);
    return;
  }
  const peaks = peaksFor(player.buf, c.width);
  const played = (position() / player.buf.duration) * c.width;
  for (let x = 0; x < c.width; x++) {
    const lo = peaks[x * 2];
    const hi = peaks[x * 2 + 1];
    g.fillStyle = x < played ? '#ffaa3c' : '#4a4f5a';
    g.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
  }
}

ui.wave.addEventListener('mousedown', (e) => {
  const rect = ui.wave.getBoundingClientRect();
  seek((e.clientX - rect.left) / rect.width);
});

// --- keyboard ---------------------------------------------------------------------------

// --- Rec / Recall -----------------------------------------------------------------
//
// The tap worklet streams the bus to us in small chunks. We keep:
//  - a ring buffer of the last RECALL_SECONDS you actually heard (idle silence
//    between auditions is skipped), saved by "Last 10s";
//  - while Rec is on, every chunk (literal, silence included).

const RECALL_SECONDS = 10;
const REC_MAX_SECONDS = 20 * 60;
const SILENCE = 1e-4; // ~-80 dBFS

const tap = { ready: null, rate: 0, ring: null, ringPos: 0, ringFill: 0, rec: null, recFrames: 0, timer: 0 };

async function startTap(ctx) {
  try {
    await ctx.audioWorklet.addModule('tap-worklet.js');
    const node = new AudioWorkletNode(ctx, 'sm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    player.bus.connect(node);
    node.connect(ctx.destination); // outputs silence; being connected keeps it rendering
    tap.rate = ctx.sampleRate;
    tap.ring = [new Float32Array(tap.rate * RECALL_SECONDS), new Float32Array(tap.rate * RECALL_SECONDS)];
    node.port.onmessage = (e) => onTapChunk(e.data[0], e.data[1]);
    return true;
  } catch (err) {
    console.error('recorder unavailable', err);
    flash("Recorder couldn't start");
    return false;
  }
}

function peak(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] < 0 ? -a[i] : a[i];
    if (v > m) m = v;
  }
  return m;
}

function onTapChunk(l, r) {
  if (tap.rec) {
    tap.rec.push([l, r]);
    tap.recFrames += l.length;
    if (tap.recFrames >= REC_MAX_SECONDS * tap.rate) stopRecording();
  }
  if (!player.playing && peak(l) < SILENCE && peak(r) < SILENCE) return;
  const size = tap.ring[0].length;
  for (let i = 0; i < l.length; i++) {
    tap.ring[0][tap.ringPos] = l[i];
    tap.ring[1][tap.ringPos] = r[i];
    tap.ringPos = (tap.ringPos + 1) % size;
  }
  tap.ringFill = Math.min(size, tap.ringFill + l.length);
}

// Drop silence at both ends.
function trimSilence(l, r) {
  let a = 0;
  let b = l.length;
  const loud = (i) => Math.abs(l[i]) >= SILENCE || Math.abs(r[i]) >= SILENCE;
  while (a < b && !loud(a)) a++;
  while (b > a && !loud(b - 1)) b--;
  return [l.subarray(a, b), r.subarray(a, b)];
}

// 24-bit stereo PCM WAV — opens anywhere (Logic, Ableton, Finder preview).
function encodeWav(l, r, rate) {
  const n = l.length;
  const buf = new ArrayBuffer(44 + n * 6);
  const dv = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 6, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 6, true);
  dv.setUint16(32, 6, true);
  dv.setUint16(34, 24, true);
  str(36, 'data');
  dv.setUint32(40, n * 6, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const ch of [l, r]) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      const s24 = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
      dv.setUint8(o, s24 & 0xff);
      dv.setUint8(o + 1, (s24 >> 8) & 0xff);
      dv.setUint8(o + 2, (s24 >> 16) & 0xff);
      o += 3;
    }
  }
  return new Uint8Array(buf);
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

async function saveAudio(l, r, name) {
  [l, r] = trimSilence(l, r);
  if (!l.length) {
    flash('Nothing audible to save');
    return;
  }
  const saved = await window.sm.saveRecording(encodeWav(l, r, tap.rate), name);
  if (!saved) return;
  const file = saved.path.split('/').pop();
  if (saved.id == null) {
    flash(`Saved ${file} (outside your library)`);
    return;
  }
  flash(`Saved ${file}`);
  await revealSample(saved.id, saved.path);
}

// Select a sample by id; if the current view hides it, switch to its folder
// (clearing search/tags) as one Back step.
async function revealSample(id, filePath) {
  let i = state.rows.findIndex((r) => r.id === id);
  if (i < 0) await refreshList(); // it may simply be new since the last refresh
  i = state.rows.findIndex((r) => r.id === id);
  if (i < 0) {
    recordNav('reveal');
    if (state.editing) cancelEdit();
    clearTimeout(searchTimer);
    ui.search.value = '';
    state.filter = { search: '', tags: new Set(), untagged: false, dirs: new Set([filePath.slice(0, filePath.lastIndexOf('/'))]) };
    renderRail();
    await refreshList({ reset: true });
    i = state.rows.findIndex((r) => r.id === id);
    if (i < 0) {
      // e.g. its folder isn't in the tree — fall back to the whole library
      state.filter.dirs.clear();
      renderRail();
      await refreshList({ reset: true });
      i = state.rows.findIndex((r) => r.id === id);
    }
  }
  if (i < 0) return;
  selectSingle(i);
  ensureVisible(i);
  renderList();
  updateRowClasses();
}

async function toggleRecording() {
  if (tap.rec) return stopRecording();
  audioCtx();
  if (!(await tap.ready)) return;
  if (player.ctx.state === 'suspended') player.ctx.resume();
  tap.rec = [];
  tap.recFrames = 0;
  tap.timer = setInterval(renderRec, 250);
  renderRec();
}

function stopRecording() {
  const chunks = tap.rec;
  if (!chunks) return;
  tap.rec = null;
  clearInterval(tap.timer);
  renderRec();
  const n = chunks.reduce((a, c) => a + c[0].length, 0);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let o = 0;
  for (const [cl, cr] of chunks) {
    l.set(cl, o);
    r.set(cr, o);
    o += cl.length;
  }
  saveAudio(l, r, `Rec ${stamp()}.wav`);
}

function recall() {
  if (!tap.ring || !tap.ringFill) {
    flash('Nothing played yet');
    return;
  }
  const size = tap.ring[0].length;
  const n = tap.ringFill;
  const start = (tap.ringPos - n + size) % size;
  const take = (ch) => {
    const out = new Float32Array(n);
    const first = Math.min(n, size - start);
    out.set(ch.subarray(start, start + first), 0);
    out.set(ch.subarray(0, n - first), first);
    return out;
  };
  saveAudio(take(tap.ring[0]), take(tap.ring[1]), `Recall ${stamp()}.wav`);
}

function renderRec() {
  ui.rec.classList.toggle('on', !!tap.rec);
  ui.rec.textContent = tap.rec ? `● ${fmtTime(tap.recFrames / tap.rate).replace(/\.\d$/, '')}` : '● Rec';
  ui.rec.title = tap.rec ? 'Stop and save recording' : 'Record what plays (saved as WAV)';
}

let flashTimer = 0;
function flash(msg) {
  ui.flash.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (ui.flash.textContent = ''), 4000);
}

// --- random -------------------------------------------------------------------------

// Pick from the whole (non-hidden) library: clear filters first, as one Back step.
async function randomSample() {
  recordNav('random');
  const f = state.filter;
  if (f.search || f.tags.size || f.untagged || f.dirs.size) {
    if (state.editing) cancelEdit();
    clearTimeout(searchTimer);
    state.filter = { search: '', tags: new Set(), untagged: false, dirs: new Set() };
    ui.search.value = '';
    renderRail();
    await refreshList({ reset: true });
  }
  const n = state.rows.length;
  if (!n) return;
  let i = Math.floor(Math.random() * n);
  if (i === state.cursor && n > 1) i = (i + 1) % n;
  selectSingle(i);
  ensureVisible(i);
  renderList();
  updateRowClasses();
  playRow(state.rows[i]);
}

function pageSize() {
  return Math.max(1, Math.floor(ui.list.clientHeight / ROW_H) - 1);
}

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;

  const bracket = e.code === 'BracketLeft' || e.key === '[' ? -1 : e.code === 'BracketRight' || e.key === ']' ? 1 : 0;
  if (mod && !e.shiftKey && bracket) {
    e.preventDefault();
    goNav(bracket);
    return;
  }
  if (mod && e.altKey && (e.code === 'KeyR' || e.key.toLowerCase() === 'r')) {
    e.preventDefault();
    const cur = state.rows[state.cursor];
    if (cur) window.sm.reveal(cur.id);
    return;
  }

  if (e.target === ui.search) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'Enter') {
      ui.search.blur();
      if (state.cursor < 0 && state.rows.length) move(1, false);
    } else if (e.key === 'Escape') {
      if (ui.search.value) {
        ui.search.value = '';
        onSearch();
      } else ui.search.blur();
    }
    return;
  }
  if (e.target.closest && e.target.closest('input')) return;

  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
      break;
    case 'PageDown':
    case 'PageUp':
      e.preventDefault();
      move((e.key === 'PageDown' ? 1 : -1) * pageSize(), e.shiftKey);
      break;
    case 'Home':
    case 'End':
      e.preventDefault();
      move(e.key === 'End' ? Infinity : -Infinity, e.shiftKey);
      break;
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'Enter':
    case 't':
      if (mod) return;
      e.preventDefault();
      if (state.cursor >= 0) startEdit(state.cursor);
      break;
    case 'Escape':
      stopPlayback();
      break;
    case '/':
      e.preventDefault();
      ui.search.focus();
      ui.search.select();
      break;
    case 'f':
      if (!mod) return;
      e.preventDefault();
      ui.search.focus();
      ui.search.select();
      break;
    case 'r':
      if (mod) return;
      e.preventDefault();
      randomSample();
      break;
    case 'a':
      if (!mod) return;
      e.preventDefault();
      selectAll();
      break;
  }
});

// --- wiring ---------------------------------------------------------------------------------

let searchTimer = 0;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const value = ui.search.value.trim();
    if (value === state.filter.search) return;
    // Searches inside the selected folders, if any (see renderSearchScope).
    changeView('search', () => {
      state.filter.search = value;
    });
  }, 120);
}
ui.search.addEventListener('input', onSearch);

async function addFolder() {
  await window.sm.addFolder();
  // library:changed fires when the scan lands; refresh now for the folder list.
  refreshAll();
}
ui.foldersMenu.addEventListener('click', () => {
  const r = ui.foldersMenu.getBoundingClientRect();
  window.sm.foldersMenu({ x: r.left, y: r.bottom + 2 }, { expanded: state.expanded.size > 0, selected: state.filter.dirs.size > 0 });
});
ui.clearFolders.addEventListener('click', deselectFolders);
window.sm.onFoldersCommand((cmd) => (cmd === 'collapse' ? collapseFolders() : deselectFolders()));
ui.collapse.addEventListener('click', collapseFolders);
ui.clearTags.addEventListener('click', (e) => {
  e.stopPropagation();
  changeView('tag', () => {
    state.filter.tags.clear();
    state.filter.untagged = false;
  });
});

ui.play.addEventListener('click', togglePlay);
ui.back.addEventListener('click', () => goNav(-1));
ui.random.addEventListener('click', randomSample);
ui.rec.addEventListener('click', toggleRecording);
ui.recall.addEventListener('click', recall);
ui.fwd.addEventListener('click', () => goNav(1));
// Mouse side buttons (3 = back, 4 = forward).
window.addEventListener('mouseup', (e) => {
  if (e.button === 3 || e.button === 4) {
    e.preventDefault();
    goNav(e.button === 3 ? -1 : 1);
  }
});
window.sm.onEditTags((id) => {
  const i = state.rows.findIndex((r) => r.id === id);
  if (i >= 0) startEdit(i);
});
ui.volume.addEventListener('input', () => {
  if (player.gain) player.gain.gain.value = +ui.volume.value;
});

// Header buttons shouldn't steal keyboard focus from the list.
for (const b of document.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());

let libTimer = 0;
window.sm.onLibraryChanged(() => {
  clearTimeout(libTimer);
  libTimer = setTimeout(refreshAll, 50);
});
window.sm.onTagsChanged(async () => {
  if (await refreshRail()) refreshList();
});
window.sm.onScanStatus(({ busy, label }) => {
  ui.status.textContent = busy ? label || 'Scanning…' : '';
});

sizeWave();
renderNav();
refreshAll();
