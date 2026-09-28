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
  volLabel: $('#vol-label'),
  fwd: $('#fwd'),
  foldersMenu: $('#folders-menu'),
  folderFilter: $('#folder-filter'),
  tagFilter: $('#tag-filter'),
  rail: $('#rail'),
  folderSection: $('#folder-section'),
  tagSection: $('#tag-section'),
  foldersToggle: $('#folders-toggle'),
  tagsToggle: $('#tags-toggle'),
  folderChips: $('#folder-chips'),
  search: $('#search'),
  status: $('#status'),
  count: $('#count'),
  folders: $('#folders'),
  tags: $('#tags'),
  tagChips: $('#tag-chips'),
  searchbox: $('#searchbox'),
  chips: $('#chips'),
  suggest: $('#suggest'),
  list: $('#list'),
  spacer: $('#spacer'),
  rows: $('#rows'),
  empty: $('#empty'),
  play: $('#play'),
  nowName: $('#now-name'),
  wave: $('#wave'),
  loop: $('#loop'),
  grip: $('#player-grip'),
  railGrip: $('#rail-grip'),
  cropInfo: $('#crop-info'),
  cropLen: $('#crop-len'),
  cropClear: $('#crop-clear'),
  cropBar: $('#crop-bar'),
  cropDrag: $('#crop-drag'),
  cropSave: $('#crop-save'),
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
  // search = what's being typed (live); queries = searches saved as chips (Enter)
  filter: { search: '', queries: [], tags: new Set(), untagged: false, dirs: new Set() },
  dirs: [], // [{ folderId, dir, n }] — directories that directly hold samples
  tree: [], // root nodes: { path, name, n, total, kids: Map, folder }
  hidden: new Set(), // hidden folder paths
  expanded: loadExpanded(), // dir paths open in the folder tree
  filterClosed: new Set(), // folders closed by hand while the folder filter is on
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
    search: [...filter.queries, filter.search].join(' '), // every word ANDed
    tags: [...filter.tags],
    untagged: filter.untagged,
    dirs: [...filter.dirs],
    rank: true, // best matches first while searching (alphabetical otherwise)
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
    filter: { search: f.search, queries: [...f.queries], tags: [...f.tags], untagged: f.untagged, dirs: [...f.dirs] },
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
  state.filter = { search: f.search, queries: [...f.queries], tags: new Set(f.tags), untagged: f.untagged, dirs: new Set(f.dirs) };
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

// --- fuzzy filter (sidebar) --------------------------------------------------------
//
// Every space-separated term must appear in the text in order, case-insensitive
// ("vdrm" → "Vintage Drum Samples"). A term found as a contiguous run is
// highlighted as that run; otherwise its letters. Returns the matched
// character indices, [] for an empty query, or null for no match.
function fuzzy(query, text) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const t = text.toLowerCase();
  const hits = new Set();
  for (const term of terms) {
    const at = t.indexOf(term);
    if (at >= 0) {
      for (let i = 0; i < term.length; i++) hits.add(at + i);
      continue;
    }
    const idx = [];
    for (let i = 0, j = 0; i < t.length && j < term.length; i++) {
      if (t[i] === term[j]) {
        idx.push(i);
        j++;
      }
    }
    if (idx.length < term.length) return null;
    for (const i of idx) hits.add(i);
  }
  return [...hits].sort((a, b) => a - b);
}

// How good a single term's match in `text` is, for ranking (null = no match):
//   whole word / word start (“snare” in “02 Snares”)  100
//   contiguous but mid-word (“nare” in “Snares”)        70
//   scattered letters (“snare” in “Vision and Verse”)   ≤ 40, less the more spread out
// Shorter names win ties slightly (a closer fit).
function termScore(term, text) {
  const t = text.toLowerCase();
  let at = t.indexOf(term);
  if (at >= 0) {
    let best = 70;
    for (; at >= 0; at = t.indexOf(term, at + 1)) {
      if (at === 0 || !/[a-z0-9]/.test(t[at - 1]) || (/[0-9]/.test(t[at - 1]) && /[a-z]/.test(term[0]))) {
        best = 100;
        break;
      }
    }
    return best - t.length * 0.05;
  }
  let first = -1;
  let last = -1;
  for (let i = 0, j = 0; i < t.length && j < term.length; i++) {
    if (t[i] === term[j]) {
      if (first < 0) first = i;
      last = i;
      j++;
      if (j === term.length) {
        const spread = last - first + 1 - term.length; // letters skipped in between
        return Math.max(1, 40 - spread * 2) - t.length * 0.05;
      }
    }
  }
  return null;
}

// <span class="name"> with the matched characters wrapped in <mark>.
function nameWithHits(text, hits) {
  const span = el('span', 'name');
  if (!hits || !hits.length) {
    span.textContent = text;
    return span;
  }
  const set = new Set(hits);
  let run = '';
  let inHit = set.has(0);
  const flush = () => {
    if (run) span.append(inHit ? el('mark', null, run) : document.createTextNode(run));
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (set.has(i) !== inHit) {
      flush();
      inHit = set.has(i);
    }
    run += text[i];
  }
  flush();
  return span;
}

// --- folder tree -------------------------------------------------------------

// Opened folders last for the session only: every launch starts with just the
// top-level folders showing (and no filters).
function loadExpanded() {
  try {
    localStorage.removeItem('sm.expanded'); // from builds that remembered it
  } catch {}
  return new Set();
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

let sidebarFlash = null; // { path, at }: the folder revealInSidebar is flashing

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// Search runs inside the selected folders; say so in the search box.
// --- search chips ---------------------------------------------------------------------
//
// The main search box shows every active filter as a chip: folders (orange,
// picked in the sidebar or typed as /folder), tags (their own hue, picked in
// the sidebar or typed as #tag) and searches saved with Enter. Folders are
// ORed (search in any of them); everything else is ANDed with what's being
// typed. × or Backspace (in an empty box) removes one.

function chip(cls, label, onRemove, hueName) {
  const c = el('span', `fchip ${cls}`);
  if (hueName) c.style.setProperty('--h', hue(hueName));
  c.append(el('span', 'fchip-label', label));
  const x = el('button', 'fchip-x', '×');
  x.title = 'Remove';
  x.tabIndex = -1;
  x.addEventListener('mousedown', (e) => e.preventDefault()); // keep typing focus
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    onRemove();
  });
  c.append(x);
  return c;
}

function renderChips() {
  const f = state.filter;
  const chips = [];
  for (const d of f.dirs) {
    const c = chip('dir', dirLabel(d), () => changeView('dir', () => f.dirs.delete(d)));
    c.title = `${d}\nClick to show in the sidebar`;
    c.querySelector('.fchip-label').addEventListener('click', () => revealInSidebar(`${d}/x`));
    chips.push(c);
  }
  if (f.untagged) chips.push(chip('tag untagged', 'untagged', () => changeView('tag', () => (f.untagged = false))));
  for (const t of f.tags) chips.push(chip('tag', t, () => changeView('tag', () => f.tags.delete(t)), t));
  f.queries.forEach((qq, i) => chips.push(chip('query', `“${qq}”`, () => changeView('search', () => f.queries.splice(i, 1)))));
  ui.chips.replaceChildren(...chips);
  ui.chips.hidden = !chips.length;
  renderSearchScope();
}

// Enter in the search box: "#name" adds that tag, anything else becomes a
// saved search chip.
function commitSearchText(text) {
  const f = state.filter;
  clearTimeout(searchTimer);
  ui.search.value = '';
  ui.search.classList.remove('dir-mode', 'tag-mode');
  closeSuggest();
  if (text.startsWith('/')) {
    const hit = folderMatches(text.slice(1))[0];
    if (hit) pickSuggestion(hit);
    else {
      flash(`No folder “${text.slice(1).trim()}”`);
      changeView('search', () => (f.search = ''));
    }
    return;
  }
  if (text.startsWith('#') && text.length > 1) {
    const name = text.slice(1).trim().toLowerCase();
    if (name === 'untagged') {
      changeView('tag', () => {
        f.search = '';
        f.tags.clear();
        f.untagged = true;
      });
    } else if (state.tagCounts.some((t) => t.name === name)) {
      changeView('tag', () => {
        f.search = '';
        f.tags.add(name);
        f.untagged = false;
      });
    } else {
      flash(`No tag “${name}”`);
      changeView('search', () => (f.search = ''));
    }
    return;
  }
  changeView('search', () => {
    f.search = '';
    if (!f.queries.includes(text)) f.queries.push(text);
  });
}

// Backspace in an empty box: remove the last chip (saved search, then tag,
// then folder — right to left).
function removeLastChip() {
  const f = state.filter;
  if (f.queries.length) changeView('search', () => f.queries.pop());
  else if (f.tags.size) changeView('tag', () => f.tags.delete([...f.tags].pop()));
  else if (f.untagged) changeView('tag', () => (f.untagged = false));
  else if (f.dirs.size) changeView('dir', () => f.dirs.delete([...f.dirs].pop()));
}

// --- /folder and #tag suggestions -----------------------------------------------------
//
// Typing "/" or "#" at the start of the search box picks a folder or tag
// instead of searching text: a list of fuzzy matches drops down, ↑↓ choose,
// Enter or Tab adds the chip, Esc cancels. The typed text takes the colour
// of the chip it will become.

const suggest = { kind: null, items: [], sel: 0 };

// termScore, plus abbreviations that start a word: "ks" → "Kicks" (90) or
// "dk" → "Drum Kits" (60) beat letters found mid-word ("ks" in "Sticks", 70)
// or scattered. Short typed abbreviations are what the / picker gets most.
function pickScore(term, text) {
  const base = termScore(term, text);
  if (base != null && base >= 90) return base;
  const t = text.toLowerCase();
  let best = base;
  for (let at = t.indexOf(term[0]); at >= 0; at = t.indexOf(term[0], at + 1)) {
    if (at > 0 && /[a-z0-9]/.test(t[at - 1])) continue; // not a word start
    let j = 1;
    let i = at + 1;
    let words = 1;
    for (; i < t.length && j < term.length; i++) {
      if (!/[a-z0-9]/.test(t[i]) && /[a-z0-9]/.test(t[i + 1] || '')) words++;
      if (t[i] === term[j]) j++;
    }
    if (j < term.length) continue;
    const sc = (words === 1 ? 90 : 60) - t.length * 0.05;
    if (best == null || sc > best) best = sc;
  }
  return best;
}

// Every visible folder in the tree whose name — with its parents' names —
// matches all the terms (same rules as the sidebar filter), best first.
// Ranked for "parent … folder" typing: "dr ks" puts Drums › Kicks above a
// folder that happens to hold both ("Drum Sticks"). No terms: the libraries.
function folderMatches(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const visit = (node, trail) => {
    if (state.hidden.has(node.path)) return;
    const names = [...trail, node.name];
    if (!terms.length) {
      if (!trail.length) out.push({ node, trail, score: 0, hits: [] });
    } else {
      let score = 0;
      let own = 0;
      let lastOwn = false;
      const hits = new Set();
      let ok = true;
      terms.forEach((term, k) => {
        if (!ok) return;
        const mine = pickScore(term, node.name);
        const up = trail.reduce((b, n) => Math.max(b, pickScore(term, n) ?? -1), -1);
        if (mine == null && up < 0) {
          ok = false;
          return;
        }
        // The last word typed usually names the folder itself; earlier ones
        // may name a parent. Prefer the folder's own match only when it's
        // at least as good.
        if (mine != null && (mine >= up || k === terms.length - 1)) {
          own++;
          if (k === terms.length - 1) lastOwn = true;
          score += mine;
          for (const i of fuzzy(term, node.name) || []) hits.add(i);
        } else score += up;
      });
      // Bonus for the tree reading the way it was typed: last word here,
      // the others above. Several words packed into one name get less.
      if (ok && own) {
        if (terms.length > 1 && lastOwn && own === 1) score += 15;
        out.push({ node, trail, score: score - names.length * 0.3, hits: [...hits] });
      }
    }
    for (const kid of node.kids.values()) visit(kid, names);
  };
  for (const root of state.tree) visit(root, []);
  out.sort((a, b) => b.score - a.score || byName(a.node, b.node));
  return out
    .filter((m) => !state.filter.dirs.has(m.node.path))
    .slice(0, 12)
    .map((m) => ({ kind: 'dir', path: m.node.path, name: m.node.name, where: m.trail.join(' › '), n: m.node.n, hits: m.hits }));
}

function tagMatches(query) {
  const q = query.trim().toLowerCase();
  const items = [...state.tagCounts, { name: 'untagged', count: state.untaggedCount }]
    .filter((t) => !state.filter.tags.has(t.name) && !(t.name === 'untagged' && state.filter.untagged))
    .map((t) => ({ t, score: q ? termScore(q, t.name) : 0 }))
    .filter((m) => m.score != null);
  items.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return items.slice(0, 12).map(({ t }) => ({ kind: 'tag', name: t.name, n: t.count, hits: q ? fuzzy(q, t.name) || [] : [] }));
}

function updateSuggest() {
  const text = ui.search.value;
  const kind = text.startsWith('/') ? 'dir' : text.startsWith('#') ? 'tag' : null;
  ui.search.classList.toggle('dir-mode', kind === 'dir');
  ui.search.classList.toggle('tag-mode', kind === 'tag');
  if (!kind || document.activeElement !== ui.search) return closeSuggest();
  const q = text.slice(1);
  suggest.kind = kind;
  suggest.items = kind === 'dir' ? folderMatches(q) : tagMatches(q);
  suggest.sel = 0;
  renderSuggest();
}

function renderSuggest() {
  const top = suggest.items[suggest.sel];
  if (suggest.kind === 'tag' && top) ui.search.style.setProperty('--h', hue(top.name));
  if (!suggest.items.length) {
    ui.suggest.replaceChildren(el('li', 'hint', suggest.kind === 'dir' ? 'No matching folder' : 'No matching tag'));
  } else {
    ui.suggest.replaceChildren(
      ...suggest.items.map((it, i) => {
        const li = el('li', `${it.kind}${i === suggest.sel ? ' sel' : ''}`);
        if (it.kind === 'tag') li.style.setProperty('--h', hue(it.name));
        const name = nameWithHits((it.kind === 'dir' ? '/' : '#') + it.name, it.hits.map((h) => h + 1));
        name.className = 's-name';
        li.append(name, el('span', 's-path', it.where || ''), el('span', 's-n', String(it.n ?? '')));
        if (it.path) li.title = it.path;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep focus in the box
          pickSuggestion(it);
        });
        li.addEventListener('mousemove', () => {
          if (suggest.sel === i) return;
          suggest.sel = i;
          renderSuggest();
        });
        return li;
      }),
    );
    ui.suggest.children[suggest.sel]?.scrollIntoView({ block: 'nearest' });
  }
  ui.suggest.hidden = false;
}

function closeSuggest() {
  suggest.kind = null;
  suggest.items = [];
  ui.suggest.hidden = true;
}

function moveSuggest(step) {
  if (!suggest.items.length) return;
  suggest.sel = (suggest.sel + step + suggest.items.length) % suggest.items.length;
  renderSuggest();
}

function pickSuggestion(it) {
  const f = state.filter;
  clearTimeout(searchTimer);
  ui.search.value = '';
  ui.search.classList.remove('dir-mode', 'tag-mode');
  closeSuggest();
  if (it.kind === 'dir') {
    changeView('dir', () => {
      f.search = '';
      f.dirs.add(it.path);
    });
  } else if (it.name === 'untagged') {
    changeView('tag', () => {
      f.search = '';
      f.tags.clear();
      f.untagged = true;
    });
  } else {
    changeView('tag', () => {
      f.search = '';
      f.tags.add(it.name);
      f.untagged = false;
    });
  }
}

ui.search.addEventListener('blur', closeSuggest);
ui.search.addEventListener('focus', updateSuggest);

ui.searchbox.addEventListener('mousedown', (e) => {
  if (e.target === ui.searchbox || e.target === ui.chips) {
    e.preventDefault();
    ui.search.focus();
  }
});

function renderSearchScope() {
  const dirs = [...state.filter.dirs];
  const name = (p) => {
    const root = state.folders.find((f) => f.path === p);
    return root ? root.label : p.split('/').pop();
  };
  const scope = !dirs.length ? '' : dirs.length === 1 ? ` in “${name(dirs[0])}”` : ` in ${dirs.length} folders`;
  const hasChips = state.filter.queries.length || state.filter.tags.size || state.filter.untagged;
  ui.search.placeholder = hasChips
    ? `Add a search${scope}…`
    : `Search${scope || ' names, folders, tags'}  ·  /folder  #tag  ·  Enter keeps it`;
}

function deselectFolders() {
  if (!state.filter.dirs.size) return;
  changeView('dir', () => state.filter.dirs.clear());
}

function collapseFolders() {
  state.expanded.clear();
  renderFolders();
}

function renderFolders() {
  const scroll = ui.folders.scrollTop;
  ui.folders.replaceChildren();
  if (!state.tree.length) ui.folders.append(el('li', 'hint', 'No folders — ⌘O to add one'));

  // Filter box: keep folders whose name fuzzy-matches, plus the folders leading
  // to them (opened automatically — without touching state.expanded, so
  // clearing the box restores the tree as it was). Below a matching folder,
  // everything shows as normal.
  const q = ui.folderFilter.value.trim();
  const hitsFor = new Map(); // path -> matched char indices
  const keep = new Set(); // paths to show
  const autoOpen = new Set(); // paths opened because something below matches
  const score = new Map(); // path -> this folder's own match score
  const best = new Map(); // path -> best score in its subtree (for ordering)
  if (q) {
    // Each term must match this folder's name or one of its parents' names,
    // and at least one must match this folder itself — so "dr ks" finds
    // Drums › Kicks. Only this folder's own matches are highlighted/scored.
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    // A term that appears as-is in some folder name only counts as-is:
    // scattered-letter matches ("Sine Saw Square" for "snare") are dropped.
    // Terms found nowhere as-is (abbreviations like "snr") stay fuzzy.
    const exactSomewhere = new Set();
    const scan = (node) => {
      const n = node.name.toLowerCase();
      for (const term of terms) if (n.includes(term)) exactSomewhere.add(term);
      node.kids.forEach(scan);
    };
    state.tree.forEach(scan);
    const match = (term, name) => {
      if (exactSomewhere.has(term) && !name.toLowerCase().includes(term)) return null;
      return termScore(term, name);
    };
    const visit = (node, ancestors) => {
      const own = [];
      let ownScore = 0;
      let ok = true;
      for (const term of terms) {
        const sc = match(term, node.name);
        if (sc != null) {
          ownScore += sc;
          own.push(...fuzzy(term, node.name));
        } else if (!ancestors.some((name) => match(term, name) != null)) ok = false;
      }
      // Shallower folders rank a little higher (category folders like
      // "03 Single Drums › 02 Snares" over one buried deep in a pack).
      if (own.length) ownScore -= ancestors.length * 0.5;
      const hits = ok && own.length ? [...new Set(own)].sort((a, b) => a - b) : null;
      if (hits) {
        hitsFor.set(node.path, hits);
        score.set(node.path, ownScore);
      }
      let bestBelow = -Infinity;
      const chain = [...ancestors, node.name];
      for (const kid of node.kids.values()) {
        if (visit(kid, chain)) bestBelow = Math.max(bestBelow, best.get(kid.path));
      }
      const below = bestBelow > -Infinity;
      // Open the way down to matches, but stop at the first matching folder on
      // each branch (it stays closed, ▸) — unless something inside it matches
      // clearly better. Keeps e.g. "snare" from unrolling 150 subfolders.
      const openIt = below && (!hits || bestBelow > ownScore + 10);
      if (openIt && !state.hidden.has(node.path) && !state.filterClosed.has(node.path)) autoOpen.add(node.path);
      if (hits || below) {
        keep.add(node.path);
        best.set(node.path, Math.max(hits ? ownScore : -Infinity, bestBelow));
      }
      return !!hits || below;
    };
    for (const root of state.tree) visit(root, []);
    if (!keep.size && state.tree.length) ui.folders.append(el('li', 'hint', 'No folders match'));
  }
  // While filtering, siblings are ordered by their best match (then by name).
  const ranked = (a, b) => best.get(b.path) - best.get(a.path) || byName(a, b);

  const addNode = (node, depth, underMatch) => {
    if (q && !underMatch && !keep.has(node.path)) return;
    // A hidden folder hides its whole subtree: it can't be expanded, so its
    // subfolders don't show until you unhide it.
    const hidden = state.hidden.has(node.path);
    const expandable = node.kids.size > 0 && !hidden;
    const open = expandable && (state.expanded.has(node.path) || autoOpen.has(node.path));
    const li = el('li', `dir${state.filter.dirs.has(node.path) ? ' on' : ''}${hidden ? ' hidden-dir' : ''}`);
    li.style.setProperty('--d', depth);
    li.dataset.path = node.path;
    // Mid-flash from revealInSidebar: carry on where the animation was.
    if (sidebarFlash && sidebarFlash.path === node.path) {
      const age = performance.now() - sidebarFlash.at;
      if (age < 1600) {
        li.classList.add('flash');
        li.style.animationDelay = `${-age}ms`;
      }
    }
    li.title = hidden ? `${node.path}\nHidden — right-click to unhide` : node.path;
    const tw = el('span', 'tw', expandable ? (open ? '▾' : '▸') : '');
    li.append(tw, nameWithHits(node.name, hitsFor.get(node.path)), el('span', 'n', (hidden ? node.total : node.n).toLocaleString()));
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
      if (open) {
        state.expanded.delete(node.path);
        if (autoOpen.has(node.path)) state.filterClosed.add(node.path);
      } else {
        state.expanded.add(node.path);
        state.filterClosed.delete(node.path);
      }
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
    const below = underMatch || hitsFor.has(node.path);
    if (open) {
      const kids = [...node.kids.values()];
      // Filtering (and not inside a match): only kept folders, best first.
      if (q && !below) kids.filter((k) => keep.has(k.path)).sort(ranked).forEach((k) => addNode(k, depth + 1, false));
      else kids.sort(byName).forEach((k) => addNode(k, depth + 1, below));
    }
  };
  const roots = q ? state.tree.filter((r) => keep.has(r.path)).sort(ranked) : state.tree;
  for (const root of roots) addNode(root, 0, false);

  ui.folders.scrollTop = scroll;
  renderFolderChips();
  renderSearchScope();
}

function renderRail() {
  renderFolders();
  renderTags();
}

function renderTags() {
  ui.tags.replaceChildren();
  const q = ui.tagFilter.value.trim();
  let shown = 0;
  const addTagItem = (name, count, on, cls, onClick) => {
    const hits = q ? fuzzy(q, name) : null;
    if (q && !hits) return;
    shown++;
    const li = el('li', [cls, on ? 'on' : ''].filter(Boolean).join(' '));
    const dot = el('span', 'dot');
    dot.style.setProperty('--h', hue(name));
    li.append(dot, nameWithHits(name, hits), el('span', 'n', count.toLocaleString()));
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
  // While filtering, best matches first (whole-word before scattered letters).
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const tagScore = (name) => terms.reduce((sum, term) => sum + (termScore(term, name) ?? 0), 0);
  const list = q ? [...state.tagCounts].sort((a, b) => tagScore(b.name) - tagScore(a.name) || a.name.localeCompare(b.name)) : state.tagCounts;
  for (const t of list) {
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
  if (q && !shown) ui.tags.append(el('li', 'hint', 'No tags match'));
  renderTagChips();
  renderChips();
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
    e.classList.toggle('cropped', player.regions.has(id));
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
  // Ids, not paths: main swaps in the cropped file for samples with a region.
  window.sm.startDrag(actionRows(+row.dataset.i).map((r) => r.id));
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
  const before = row ? [...row.tags] : null;
  const tags = edit.value.split(',').map((s) => s.trim()).filter(Boolean);
  const saved = await saveTags(edit.id, tags);
  if (saved && before && saved.join(',') !== before.join(',')) {
    tagUndo.push({ id: edit.id, name: row.filename, before, after: saved });
    if (tagUndo.length > 100) tagUndo.shift();
    tagRedo.length = 0;
  }
}

async function saveTags(id, tags) {
  try {
    const saved = await window.sm.updateTags(id, tags);
    const row = state.rows.find((r) => r.id === id);
    if (row) {
      row.tags = saved;
      patchRow(row);
    }
    return saved;
  } catch (err) {
    console.error('saving tags failed', err);
    return null;
  }
}

// Undo / redo of tag edits (⌘Z / ⇧⌘Z, or Edit › Undo / Redo). While typing
// in a text field they undo the typing instead.
const tagUndo = [];
const tagRedo = [];

async function undoTags(redo) {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
    document.execCommand(redo ? 'redo' : 'undo');
    return;
  }
  const step = (redo ? tagRedo : tagUndo).pop();
  if (!step) {
    flash(redo ? 'Nothing to redo' : 'Nothing to undo');
    return;
  }
  const saved = await saveTags(step.id, redo ? step.after : step.before);
  if (!saved) return;
  (redo ? tagUndo : tagRedo).push(step);
  const i = state.rows.findIndex((r) => r.id === step.id);
  if (i >= 0) {
    selectSingle(i);
    ensureVisible(i);
    renderList();
    updateRowClasses();
  }
  flash(`${redo ? 'Redid' : 'Undid'} tag change on ${step.name}`);
}
window.sm.onUndo((redo) => undoTags(redo));

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
  view: null, // zoomed waveform window { start, end } (seconds), or null = whole file
  loop: false, // see the loop section: on with a region, off by default
  loopSpan: null,
  regions: new Map(), // crop regions this session: sample id -> { start, end } (seconds)
  error: null,
};

// Graph: sources → bus → volume → speakers
//                     └──→ tap (Rec / Recall, pre-volume)
function audioCtx() {
  if (!player.ctx) {
    player.ctx = new AudioContext({ latencyHint: 'interactive' });
    player.bus = player.ctx.createGain();
    player.gain = player.ctx.createGain();
    player.gain.gain.value = volumeGain();
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
  if (!player.playing) return player.offset;
  let t = player.ctx.currentTime - player.startTime;
  if (player.loopSpan) {
    const [a, b] = player.loopSpan;
    if (t >= b) t = a + ((t - a) % (b - a));
  }
  return t;
}

// The playable span: the crop region if the loaded sample has one, else all of it.
function curRegion() {
  return (player.row && player.regions.get(player.row.id)) || null;
}

function span() {
  const reg = curRegion();
  return reg ? [reg.start, reg.end] : [0, player.buf ? player.buf.duration : 0];
}

function startAt(offset) {
  const ctx = audioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  stopSource();
  const [s0, s1] = span();
  if (!(offset >= s0 && offset < s1 - 0.001)) offset = s0; // outside the span, or at its end: from the top
  const src = ctx.createBufferSource();
  src.buffer = player.buf;
  src.connect(player.bus);
  src.onended = () => {
    if (player.src !== src) return;
    player.src = null;
    player.playing = false;
    player.offset = s0;
    renderPlayer();
  };
  // Loop the span: the crop region if there is one, else the whole sample.
  const looping = player.loop;
  if (looping) {
    src.loop = true;
    src.loopStart = s0;
    src.loopEnd = s1;
    src.start(0, offset);
  } else {
    src.start(0, offset, s1 - offset);
  }
  player.loopSpan = looping ? [s0, s1] : null;
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
  player.view = null;
  setLoop(loopChoice || player.regions.has(row.id));
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
  startAt(player.offset); // startAt wraps to the span start when at its end
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
  seekTo(clamp(frac, 0, 1) * player.buf.duration);
}

function seekTo(t) {
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
  const reg = curRegion();
  ui.cropInfo.classList.toggle('off', !reg);
  if (reg) ui.cropLen.textContent = `✂ ${(reg.end - reg.start).toFixed(2)}s`;
  drawWave();
}

// --- waveform ---------------------------------------------------------------------------
//
// The waveform shows a *view* of the loaded sample: the whole file, or a
// zoomed-in window (⌥-scroll to zoom, horizontal scroll to pan). All mouse ↔
// time mapping goes through viewSpan().

const ZOOM_PER_PX = 0.0012; // ⌥-scroll sensitivity: a mouse-wheel notch (~100px) ≈ 13%
const MIN_VIEW_S = 0.05; // deepest zoom: 50ms across the whole waveform…
const MAX_ZOOM = 100; // …or 1/100 of the file, whichever is longer

function viewSpan() {
  const dur = player.buf ? player.buf.duration : 0;
  return player.view ? [player.view.start, player.view.end] : [0, dur];
}

function setView(start, end) {
  const dur = player.buf.duration;
  const span = end - start;
  if (span >= dur - 1e-6) player.view = null;
  else {
    const s = clamp(start, 0, dur - span);
    player.view = { start: s, end: s + span };
  }
  drawWave();
}

function sizeWave() {
  const dpr = window.devicePixelRatio || 1;
  ui.wave.width = Math.max(1, Math.round(ui.wave.clientWidth * dpr));
  ui.wave.height = Math.max(1, Math.round(ui.wave.clientHeight * dpr));
  drawWave();
}

// Min/max per pixel column for the current view; cached until the view or
// canvas width changes (not per frame while playing).
function peaksFor(buf, width, v0, v1) {
  const key = `${width}|${v0}|${v1}`;
  const cached = player.peaks.get(buf);
  if (cached && cached.key === key) return cached.data;
  const data = new Float32Array(width * 2);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const a0 = v0 * buf.sampleRate;
  const per = ((v1 - v0) * buf.sampleRate) / width;
  for (let x = 0; x < width; x++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(a0 + x * per);
    const b = Math.max(a + 1, Math.floor(a0 + (x + 1) * per));
    const step = Math.max(1, Math.floor((b - a) / 256)); // subsample long spans
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
  player.peaks.set(buf, { key, data });
  return data;
}

// Keep the crop handle centred on the visible part of the region.
function placeCropBar(r) {
  const visible = r && r.x1 > 0 && r.x0 < r.W;
  ui.cropBar.hidden = !visible;
  if (!visible) return;
  const scale = ui.wave.clientWidth / r.W; // canvas px → CSS px
  const mid = ((Math.max(0, r.x0) + Math.min(r.W, r.x1)) / 2) * scale;
  const half = ui.cropBar.offsetWidth / 2 + 4;
  ui.cropBar.style.left = `${clamp(mid, half, ui.wave.clientWidth - half)}px`;
}

function drawWave() {
  const c = ui.wave;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const mid = c.height / 2;
  if (!player.buf) {
    g.fillStyle = '#2e3138';
    g.fillRect(0, mid, c.width, 1);
    placeCropBar(null);
    return;
  }
  // While playing zoomed in, page the view along with the playhead — except
  // when looping: then the view stays where you zoomed, even if the loop
  // runs outside it.
  let [v0, v1] = viewSpan();
  const pos = position();
  if (player.view && player.playing && !player.loopSpan && (pos < v0 || pos > v1)) {
    setView(pos, pos + (v1 - v0));
    return; // setView redraws
  }
  const W = c.width;
  const xOf = (t) => ((t - v0) / (v1 - v0)) * W;
  const peaks = peaksFor(player.buf, W, v0, v1);
  const played = xOf(pos);
  const reg = curRegion();
  const x0 = reg ? xOf(reg.start) : -Infinity;
  const x1 = reg ? xOf(reg.end) : Infinity;
  placeCropBar(reg && { x0, x1, W });
  if (reg) {
    g.fillStyle = 'rgba(255, 170, 60, 0.13)';
    g.fillRect(x0, 0, x1 - x0, c.height);
  }
  for (let x = 0; x < W; x++) {
    const lo = peaks[x * 2];
    const hi = peaks[x * 2 + 1];
    const inside = x >= x0 && x < x1;
    g.fillStyle = !inside ? '#2f333b' : x < played ? '#ffaa3c' : '#4a4f5a';
    g.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
  }
  const dpr = window.devicePixelRatio || 1;
  if (reg) {
    g.fillStyle = '#ffaa3c';
    g.fillRect(x0, 0, 2 * dpr, c.height);
    g.fillRect(x1 - 2 * dpr, 0, 2 * dpr, c.height);
  }
  if (player.view) {
    // Where the view sits in the whole file: a thin bar along the bottom.
    const dur = player.buf.duration;
    g.fillStyle = 'rgba(255, 255, 255, 0.08)';
    g.fillRect(0, c.height - 3 * dpr, W, 3 * dpr);
    g.fillStyle = 'rgba(255, 170, 60, 0.6)';
    g.fillRect((v0 / dur) * W, c.height - 3 * dpr, Math.max(2 * dpr, ((v1 - v0) / dur) * W), 3 * dpr);
  }
}

ui.wave.addEventListener(
  'wheel',
  (e) => {
    if (!player.buf) return;
    const [v0, v1] = viewSpan();
    const span = v1 - v0;
    const dur = player.buf.duration;
    if (e.altKey) {
      // ⌥-scroll (either axis) zooms around the mouse. Deltas are clamped so a
      // fast trackpad flick can't jump from full view to max zoom at once.
      e.preventDefault();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const minSpan = Math.min(dur, Math.max(MIN_VIEW_S, dur / MAX_ZOOM));
      const next = clamp(span * Math.exp(clamp(delta, -120, 120) * ZOOM_PER_PX), minSpan, dur);
      const t = waveTime(e.clientX);
      const frac = (t - v0) / span;
      setView(t - frac * next, t - frac * next + next);
    } else if (player.view && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Plain horizontal scroll pans when zoomed in.
      e.preventDefault();
      const w = ui.wave.getBoundingClientRect().width;
      setView(v0 + (e.deltaX / w) * span, v1 + (e.deltaX / w) * span);
    }
  },
  { passive: false },
);

// --- crop regions ------------------------------------------------------------------------
//
// On the waveform: drag outside the region to select a new one, drag its edges
// to resize, drag inside it to move it, click to seek, double-click to clear.
// I / O set start / end at the playhead. A region limits (and, with Loop on,
// loops) playback, and dragging the sample out drags just that part — main
// renders the cropped file as soon as the region is set, so drags are instant.

const EDGE_PX = 6;
let waveDrag = null;

function waveTime(clientX) {
  const rect = ui.wave.getBoundingClientRect();
  const [v0, v1] = viewSpan();
  return clamp(v0 + ((clientX - rect.left) / rect.width) * (v1 - v0), 0, player.buf.duration);
}

// What's under the mouse: a region edge, the region body, or empty wave.
function hitTest(clientX) {
  const reg = curRegion();
  if (!reg) return { part: 'wave' };
  const [v0, v1] = viewSpan();
  const px = ui.wave.getBoundingClientRect().width / (v1 - v0);
  const t = waveTime(clientX);
  if (Math.abs(t - reg.start) * px <= EDGE_PX) return { part: 'edge', other: reg.end };
  if (Math.abs(t - reg.end) * px <= EDGE_PX) return { part: 'edge', other: reg.start };
  if (t > reg.start && t < reg.end) return { part: 'body' };
  return { part: 'wave' };
}

// While a region loops, move the playing loop points to `reg` in place, so an
// edge drag or move is heard immediately (and without restarting) — as long as
// the playhead is inside the new region (else it wraps to the region start).
// Returns false if nothing is looping.
function liveLoop(reg) {
  if (!player.playing || !player.src || !player.loopSpan) return false;
  const p = position();
  if (!(p >= reg.start && p < reg.end)) {
    // e.g. the end was dragged to before the playhead: wrap to the start now.
    startAt(reg.start);
    return true;
  }
  player.src.loopStart = reg.start;
  player.src.loopEnd = reg.end;
  // Re-anchor position() to the new span.
  player.startTime = player.ctx.currentTime - p;
  player.loopSpan = [reg.start, reg.end];
  return true;
}

let lastCropLength = 1; // seconds; ⇧R's random regions use it

function commitRegion(start, end) {
  const row = player.row;
  if (!row || !player.buf) return;
  if (end - start < 0.01) return clearRegion();
  const reg = { start: Math.max(0, start), end: Math.min(player.buf.duration, end) };
  player.regions.set(row.id, reg);
  lastCropLength = reg.end - reg.start;
  setLoop(true);
  window.sm.prepareCrop(row.id, reg.start, reg.end).catch((err) => {
    console.error(err);
    if (player.regions.get(row.id) === reg) flash(`Can't crop ${row.format.toUpperCase()} files — dragging will use the whole sample`);
  });
  updateRowClasses();
  // Already looping and the playhead is inside: keep going with the new loop
  // points. Otherwise audition the crop from its start.
  if (!liveLoop(reg)) startAt(reg.start);
  renderPlayer();
}

function clearRegion() {
  const row = player.row;
  if (!row || !player.regions.has(row.id)) return;
  player.regions.delete(row.id);
  window.sm.clearCrop(row.id);
  setLoop(loopChoice);
  updateRowClasses();
  if (player.playing) startAt(position()); // drop the loop points, keep playing
  else renderPlayer();
}

function onWaveMove(e) {
  const d = waveDrag;
  if (!d || (!d.moved && Math.abs(e.clientX - d.x0) < 3)) return;
  d.moved = true;
  const t = waveTime(e.clientX);
  let reg;
  if (d.part === 'body') {
    // Move, keeping the length, stopping at the file's ends.
    const len = d.orig.end - d.orig.start;
    const start = clamp(d.orig.start + (t - d.grab), 0, player.buf.duration - len);
    reg = { start, end: start + len };
  } else {
    reg = { start: Math.min(t, d.fixed), end: Math.max(t, d.fixed) };
  }
  // Live preview while dragging (heard live if it's looping); committed — and
  // rendered to a file by main — on mouseup.
  player.regions.set(player.row.id, reg);
  liveLoop(reg);
  drawWave();
}

function onWaveUp(e) {
  window.removeEventListener('mousemove', onWaveMove);
  const d = waveDrag;
  waveDrag = null;
  if (!d || !player.buf) return;
  if (d.moved) {
    const r = player.regions.get(player.row.id);
    return commitRegion(r.start, r.end);
  }
  // A click, not a drag: seek there (clicking outside the region clears it).
  const t = waveTime(e.clientX);
  if (d.part === 'wave' && curRegion()) clearRegion();
  seekTo(t);
}

ui.wave.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !player.buf) return;
  e.preventDefault();
  const hit = hitTest(e.clientX);
  const t = waveTime(e.clientX);
  waveDrag = { part: hit.part, x0: e.clientX, moved: false };
  if (hit.part === 'edge') waveDrag.fixed = hit.other;
  else if (hit.part === 'body') Object.assign(waveDrag, { grab: t, orig: { ...curRegion() } });
  else waveDrag.fixed = t;
  window.addEventListener('mousemove', onWaveMove);
  window.addEventListener('mouseup', onWaveUp, { once: true });
});
ui.wave.addEventListener('mousemove', (e) => {
  if (waveDrag || !player.buf) return;
  const part = hitTest(e.clientX).part;
  ui.wave.style.cursor = part === 'edge' ? 'ew-resize' : part === 'body' ? 'grab' : 'crosshair';
});
ui.wave.addEventListener('dblclick', clearRegion);

// I / O: set the region start / end at the playhead.
function setRegionEdge(which) {
  if (!player.buf) return;
  const t = position();
  const reg = curRegion() || { start: 0, end: player.buf.duration };
  let { start, end } = reg;
  if (which === 'in') {
    start = t;
    if (end <= start) end = player.buf.duration;
  } else {
    end = t;
    if (end <= start) start = 0;
  }
  commitRegion(start, end);
}

// --- loop --------------------------------------------------------------------------------

// Loop is off at launch. Turning it on with the button (or L) keeps it on
// while you move through samples, until you turn it off again. A crop region
// loops on its own either way; clearing it goes back to the button's setting.
// On with no region loops the whole sample.
let loopChoice = false; // what the button last set

function setLoop(on) {
  player.loop = on;
  renderLoop();
}

function toggleLoop() {
  loopChoice = !player.loop;
  setLoop(loopChoice);
  if (player.playing) startAt(position()); // apply to what's playing now
}

function renderLoop() {
  ui.loop.classList.toggle('on', player.loop);
  ui.loop.setAttribute('aria-pressed', String(player.loop));
  ui.loop.title = `Loop: ${player.loop ? 'on' : 'off'} (L)`;
}

// --- resizable player -----------------------------------------------------------------------

const WAVE_MIN = 40;

function setWaveHeight(h) {
  const max = Math.max(WAVE_MIN, Math.round(window.innerHeight * 0.6));
  const px = clamp(Math.round(h), WAVE_MIN, max);
  document.documentElement.style.setProperty('--wave-h', `${px}px`);
  return px;
}

(() => {
  try {
    const saved = +localStorage.getItem('sm.waveH');
    if (saved) setWaveHeight(saved);
  } catch {}
})();

ui.grip.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const y0 = e.clientY;
  const h0 = ui.wave.clientHeight;
  document.body.classList.add('resizing');
  const move = (ev) => setWaveHeight(h0 + (y0 - ev.clientY)); // drag up = taller
  window.addEventListener('mousemove', move);
  window.addEventListener(
    'mouseup',
    () => {
      window.removeEventListener('mousemove', move);
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem('sm.waveH', String(ui.wave.clientHeight));
      } catch {}
    },
    { once: true },
  );
});
ui.grip.addEventListener('dblclick', () => {
  document.documentElement.style.removeProperty('--wave-h'); // back to the CSS default
  try {
    localStorage.removeItem('sm.waveH');
  } catch {}
});
new ResizeObserver(sizeWave).observe(ui.wave);

// --- resizable sidebar ----------------------------------------------------------------------
// Drag the sidebar's right edge (deep folder trees need room); remembered.
// Double-click the edge to reset.

const RAIL_MIN = 180;

function setRailWidth(w) {
  const max = Math.max(RAIL_MIN, Math.min(640, Math.round(window.innerWidth * 0.5)));
  const px = clamp(Math.round(w), RAIL_MIN, max);
  document.documentElement.style.setProperty('--rail-w', `${px}px`);
  return px;
}

(() => {
  try {
    const saved = +localStorage.getItem('sm.railW');
    if (saved) setRailWidth(saved);
  } catch {}
})();

ui.railGrip.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const x0 = e.clientX;
  const w0 = ui.rail.getBoundingClientRect().width;
  document.body.classList.add('resizing-x');
  const move = (ev) => setRailWidth(w0 + (ev.clientX - x0));
  window.addEventListener('mousemove', move);
  window.addEventListener(
    'mouseup',
    () => {
      window.removeEventListener('mousemove', move);
      document.body.classList.remove('resizing-x');
      try {
        localStorage.setItem('sm.railW', String(Math.round(ui.rail.getBoundingClientRect().width)));
      } catch {}
    },
    { once: true },
  );
});
ui.railGrip.addEventListener('dblclick', () => {
  document.documentElement.style.removeProperty('--rail-w');
  try {
    localStorage.removeItem('sm.railW');
  } catch {}
});

// --- keyboard ---------------------------------------------------------------------------

// --- Rec / Recall -----------------------------------------------------------------
//
// The tap worklet streams the bus to us in small chunks. We keep:
//  - a ring buffer of the last RECALL_SECONDS, silence included (the gaps
//    between hits are the rhythm), saved by "Last 10s";
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

function onTapChunk(l, r) {
  if (tap.rec) {
    tap.rec.push([l, r]);
    tap.recFrames += l.length;
    if (tap.recFrames >= REC_MAX_SECONDS * tap.rate) stopRecording();
  }
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
    state.filter = { search: '', queries: [], tags: new Set(), untagged: false, dirs: new Set([filePath.slice(0, filePath.lastIndexOf('/'))]) };
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

// Random pick from what's listed: whatever the current search / tags /
// folders match, or — with no filters — the whole (non-hidden) library.
// A Back step, so ⌘[ returns to the previous sample.
// R: a random sample from what the filters show. ⇧R: that, plus a crop
// region at a random spot in it, looping — as long as the last crop you
// made (1s before any).
async function randomSample(withRegion = false) {
  const n = state.rows.length;
  if (!n) return;
  recordNav('random');
  let i = Math.floor(Math.random() * n);
  if (i === state.cursor && n > 1) i = (i + 1) % n;
  selectSingle(i);
  ensureVisible(i);
  renderList();
  updateRowClasses();
  const row = state.rows[i];
  await playRow(row);
  if (!withRegion || player.row !== row || !player.buf) return;
  const dur = player.buf.duration;
  const len = lastCropLength < dur ? lastCropLength : dur / 2;
  const start = Math.random() * (dur - len);
  commitRegion(start, start + len);
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

  if (e.target === ui.search && suggest.kind) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSuggest(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault();
      const it = suggest.items[suggest.sel];
      if (it) pickSuggestion(it);
      else if (e.key === 'Enter') commitSearchText(ui.search.value.trim());
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      ui.search.value = '';
      onSearch();
      return;
    }
  }
  if (e.target === ui.search) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'Enter') {
      const text = ui.search.value.trim();
      if (text) {
        e.preventDefault();
        commitSearchText(text); // keep focus: type the next one
      } else {
        ui.search.blur();
        if (state.cursor < 0 && state.rows.length) move(1, false);
      }
    } else if (e.key === 'Backspace' && !ui.search.value) {
      removeLastChip();
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
      // With a crop region: clear it, keep playing from where it is.
      // Without one: stop.
      if (curRegion()) clearRegion();
      else stopPlayback();
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
    case 'l':
      if (mod) return;
      e.preventDefault();
      toggleLoop();
      break;
    case 'i':
    case 'o':
      if (mod) return;
      e.preventDefault();
      setRegionEdge(e.key === 'i' ? 'in' : 'out');
      break;
    case 'r':
    case 'R':
      if (mod) return;
      e.preventDefault();
      randomSample(e.shiftKey);
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
  updateSuggest();
  searchTimer = setTimeout(() => {
    // "/folder" and "#tag" pick a chip (see updateSuggest), they don't search.
    const raw = ui.search.value.trim();
    const value = raw.startsWith('/') || raw.startsWith('#') ? '' : raw;
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
// Active filters, one chip each, under the Folders / Tags headers — visible
// even with the section collapsed. Click a chip to find it in the sidebar;
// × removes just that one.
function dirLabel(p) {
  const root = state.folders.find((f) => f.path === p);
  return root ? root.label : p.split('/').pop();
}

function renderFolderChips() {
  const chips = [...state.filter.dirs].map((d) => {
    const c = chip('dir', dirLabel(d), () => changeView('dir', () => state.filter.dirs.delete(d)));
    c.title = d;
    c.querySelector('.fchip-label').addEventListener('click', () => revealInSidebar(`${d}/x`));
    return c;
  });
  ui.folderChips.replaceChildren(...chips);
  ui.folderChips.hidden = !chips.length;
}

function renderTagChips() {
  const f = state.filter;
  const chips = f.untagged
    ? [chip('tag untagged', 'untagged', () => changeView('tag', () => (f.untagged = false)))]
    : [...f.tags].map((t) => chip('tag', t, () => changeView('tag', () => f.tags.delete(t)), t));
  ui.tagChips.replaceChildren(...chips);
  ui.tagChips.hidden = !chips.length;
}

function clearTagFilter() {
  changeView('tag', () => {
    state.filter.tags.clear();
    state.filter.untagged = false;
  });
}

// Sidebar filter boxes: narrow the folder tree / tag list as you type.
// Esc clears the box (a second Esc leaves it).
function wireRailFilter(input, render, list) {
  input.addEventListener('input', () => {
    state.filterClosed.clear();
    render();
    list.scrollTop = 0;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (input.value) {
      input.value = '';
      state.filterClosed.clear();
      render();
    } else input.blur();
  });
}
wireRailFilter(ui.folderFilter, renderFolders, ui.folders);
wireRailFilter(ui.tagFilter, renderTags, ui.tags);

// "Show in Sidebar": open the tree down to a sample's folder, scroll to it and
// flash it. Doesn't touch filters. Stops at a hidden folder (can't be opened).
function revealInSidebar(filePath) {
  const dir = filePath.slice(0, filePath.lastIndexOf('/'));
  const root = state.tree.find((r) => dir === r.path || dir.startsWith(r.path + '/'));
  if (!root) return;
  let node = root;
  const segs = dir === root.path ? [] : dir.slice(root.path.length + 1).split('/');
  for (const seg of segs) {
    const kid = node.kids.get(seg);
    if (!kid || state.hidden.has(node.path)) break;
    state.expanded.add(node.path);
    node = kid;
  }
  if (ui.folderSection.classList.contains('collapsed')) toggleSection(ui.folderSection, ui.foldersToggle);
  renderFolders();
  const li = [...ui.folders.children].find((l) => l.dataset.path === node.path);
  if (!li) return;
  li.scrollIntoView({ block: 'center' });
  li.classList.remove('flash');
  li.style.animationDelay = '';
  void li.offsetWidth; // restart the animation if it's already flashing
  li.classList.add('flash');
  sidebarFlash = { path: node.path, at: performance.now() }; // survives re-renders
}
window.sm.onShowInSidebar(revealInSidebar);
// Quick Search → "open in Sample Manager": select it here (switching view if hidden).
window.sm.onReveal(({ id, path: filePath }) => revealSample(id, filePath));

// Sidebar sections collapse to their header; the other one takes the room.
// Session-only: both are open at launch.
function toggleSection(section, button) {
  const collapsed = section.classList.toggle('collapsed');
  button.setAttribute('aria-expanded', String(!collapsed));
  button.querySelector('.chev').textContent = collapsed ? '▸' : '▾';
  ui.rail.classList.toggle('tags-collapsed', ui.tagSection.classList.contains('collapsed'));
}
ui.foldersToggle.addEventListener('click', () => toggleSection(ui.folderSection, ui.foldersToggle));
ui.tagsToggle.addEventListener('click', () => toggleSection(ui.tagSection, ui.tagsToggle));
window.sm.onFoldersCommand((cmd) => (cmd === 'collapse' ? collapseFolders() : deselectFolders()));

ui.play.addEventListener('click', togglePlay);
ui.loop.addEventListener('click', toggleLoop);
ui.back.addEventListener('click', () => goNav(-1));
ui.random.addEventListener('click', (e) => randomSample(e.shiftKey));
ui.cropClear.addEventListener('click', clearRegion);

// The handle drags out (or saves) just the crop — its own element, so it never
// moves or resizes the region itself.
ui.cropDrag.addEventListener('dragstart', (e) => {
  e.preventDefault();
  if (player.row && curRegion()) window.sm.startDrag([player.row.id]);
});
ui.cropSave.addEventListener('mousedown', (e) => e.preventDefault());
ui.cropSave.addEventListener('click', async () => {
  if (!player.row || !curRegion()) return;
  try {
    const saved = await window.sm.saveCrop(player.row.id);
    if (saved) flash(`Saved ${saved.split('/').pop()}`);
  } catch (err) {
    console.error(err);
    flash("Couldn't save the crop");
  }
});
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
// Volume slider 0–100 in decibels: the middle (50) is 0 dB — samples play
// exactly as recorded — the right end +6 dB, the left end silence (-48 dB just
// before it). Double-click snaps back to 0 dB. Rec / Last 10s record before
// this, so the slider never changes what gets saved.
function volumeDb() {
  const v = +ui.volume.value;
  return v >= 50 ? ((v - 50) / 50) * 6 : ((50 - v) / 50) * -48;
}

function volumeGain() {
  return +ui.volume.value === 0 ? 0 : 10 ** (volumeDb() / 20);
}

function onVolume() {
  if (player.gain) player.gain.gain.value = volumeGain();
  const db = volumeDb();
  const txt = Math.abs(db) < 0.05 ? '0' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
  ui.volLabel.title = +ui.volume.value === 0 ? 'Volume: muted' : `Volume: ${txt} dB`;
}
ui.volume.addEventListener('input', onVolume);
ui.volume.addEventListener('dblclick', () => {
  ui.volume.value = 50;
  onVolume();
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
renderLoop();
renderNav();
refreshAll();
