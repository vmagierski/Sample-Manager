'use strict';

// Quick Search panel: type to search the library, ↑/↓ to audition, drag a
// result into the DAW, ↵ to open it in the main window. Plain words are ANDed
// (every word must match). "#tag" becomes a tag chip — a prefix is enough
// ("#ki" → kick) and Space / Tab / ↵ turns it into a chip. Results are ranked
// with file-name matches first and capped at LIMIT.

const LIMIT = 200;
const CACHE = 8; // decoded buffers kept for instant re-audition

const $ = (s) => document.querySelector(s);
const ui = { q: $('#q'), results: $('#results'), count: $('#count'), wave: $('#wave'), chips: $('#qchips') };
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let rows = [];
let sel = -1;
let tagNames = [];
let total = 0;
let chipTags = []; // committed tag chips

// Typing the app's own name ("sample manager", or just "sam") offers an
// "Open Sample Manager" row first, like Spotlight does for apps. The list is
// then: [that row?, ...rows]; itemAt() maps a list index to either.
const APP_ITEM = { app: true };
let appRow = false;
const itemAt = (i) => (appRow ? (i === 0 ? APP_ITEM : rows[i - 1]) : rows[i]);
const itemCount = () => rows.length + (appRow ? 1 : 0);

function wantsApp(text) {
  const q = text.trim().toLowerCase();
  if (q.length < 3 || chipTags.length) return false;
  const name = 'sample manager';
  const words = name.split(' ');
  return name.startsWith(q) || q.split(/\s+/).every((w) => words.some((n) => n.startsWith(w)));
}

function hue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function fmtDur(ms) {
  if (ms == null) return '';
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Resolve a tag prefix to the shortest tag it starts ("ki" → "kick"), or null.
function resolveTag(prefix) {
  const p = prefix.toLowerCase();
  return tagNames.filter((t) => t.startsWith(p)).sort((a, b) => a.length - b.length)[0] || null;
}

// Search words from the text box, plus the tags in effect: the chips and any
// "#tag" still being typed (so results follow along before it's a chip).
function parse(text) {
  const words = [];
  const tags = [...chipTags];
  let pending = null; // the "#…" being typed, resolved
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('#') && tok.length > 1) {
      const hit = resolveTag(tok.slice(1));
      tags.push(hit || tok.slice(1).toLowerCase());
      pending = hit || `${tok.slice(1)}?`;
    } else words.push(tok);
  }
  return { search: words.join(' '), tags: [...new Set(tags)], pending };
}

// Turn completed "#tag" tokens into chips. `all` also takes the last token
// (Tab / ↵); otherwise only ones followed by a space. Returns true if any.
function commitTags(all) {
  const text = ui.q.value;
  const parts = text.split(/(\s+)/);
  let changed = false;
  const keep = parts.map((tok, i) => {
    const complete = all || i < parts.length - 1;
    if (!complete || !tok.startsWith('#') || tok.length < 2) return tok;
    const hit = resolveTag(tok.slice(1));
    if (!hit) return tok;
    if (!chipTags.includes(hit)) chipTags.push(hit);
    changed = true;
    return '';
  });
  if (!changed) return false;
  ui.q.value = keep.join('').replace(/\s+/g, ' ').trimStart();
  renderChips();
  return true;
}

function renderChips() {
  ui.chips.replaceChildren(
    ...chipTags.map((t) => {
      const c = el('span', 'qchip', t);
      c.style.setProperty('--h', hue(t));
      const x = el('button', 'qchip-x', '×');
      x.tabIndex = -1;
      x.addEventListener('mousedown', (e) => e.preventDefault());
      x.addEventListener('click', () => {
        chipTags = chipTags.filter((n) => n !== t);
        renderChips();
        search();
        ui.q.focus();
      });
      c.append(x);
      return c;
    }),
  );
  ui.chips.hidden = !chipTags.length;
  ui.q.placeholder = chipTags.length ? 'Add words or #tags…' : 'Search samples…   #tag to filter by tag';
}

// Highlight search words in a file name.
function highlight(text, words) {
  const span = el('span', 'name');
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    const at = lower.indexOf(w.toLowerCase());
    if (at >= 0) for (let i = at; i < at + w.length; i++) marks[i] = true;
  }
  let run = '';
  let on = marks[0];
  const flush = () => {
    if (run) span.append(on ? el('mark', null, run) : document.createTextNode(run));
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== on) {
      flush();
      on = marks[i];
    }
    run += text[i];
  }
  flush();
  return span;
}

// --- search ---------------------------------------------------------------------

let seq = 0;
let timer = 0;
async function search() {
  const my = ++seq;
  const text = ui.q.value;
  const { search: words, tags, pending } = parse(text);
  if (!words && !tags.length) {
    if (!total) total = (await window.sm.listSamples({ limit: 1 })).total;
    if (my !== seq) return;
    rows = [];
    appRow = false;
    sel = -1;
    render(`Type to search ${total.toLocaleString()} samples · #tag filters by tag`);
    ui.count.textContent = '';
    return;
  }
  const res = await window.sm.listSamples({ search: words, tags, rank: true, limit: LIMIT });
  if (my !== seq) return;
  rows = res.rows;
  total = res.total;
  appRow = wantsApp(text);
  sel = itemCount() ? 0 : -1;
  const wordList = words.split(/\s+/).filter(Boolean);
  render(itemCount() ? '' : 'No samples match', wordList, pending);
  if (!appRow && rows.length) play(rows[0]); // the app row is selected instead: nothing to hear
}

function render(hint, words = [], pending = null) {
  ui.results.replaceChildren();
  if (hint) ui.results.append(el('li', 'hint', hint));
  if (appRow) {
    const li = el('li', `app${sel === 0 ? ' sel' : ''}`);
    li.dataset.i = 0;
    const main = el('span', 'main');
    main.append(el('span', 'name', 'Open Sample Manager'), el('span', 'dir', 'Show the main window · ↵'));
    li.append(el('span', 'icon app-icon', '◧'), main, el('span', 'tags'), el('span', 'dur'));
    ui.results.append(li);
  }
  const offset = appRow ? 1 : 0;
  rows.forEach((r, i) => {
    const li = el('li', i + offset === sel ? 'sel' : '');
    li.dataset.i = i + offset;
    li.draggable = true;
    const main = el('span', 'main');
    main.append(highlight(r.filename, words), el('span', 'dir', r.relPath.slice(0, -r.filename.length - 1)));
    const chips = el('span', 'tags');
    for (const t of r.tags.slice(0, 3)) {
      const c = el('span', 'chip', t);
      c.style.setProperty('--h', hue(t));
      chips.append(c);
    }
    li.append(el('span', 'icon', '▶'), main, chips, el('span', 'dur', fmtDur(r.durationMs)));
    ui.results.append(li);
  });
  // Count, plus what's being searched for: "17 · all words" when several words
  // are ANDed, and a Tab hint for a #tag being typed.
  const n = rows.length === LIMIT ? `${LIMIT}+` : String(rows.length);
  const notes = [];
  if (words.length > 1) notes.push('all words');
  if (pending) notes.push(pending.endsWith('?') ? `no tag “${pending.slice(0, -1)}”` : `⇥ #${pending}`);
  ui.count.textContent = [rows.length || hint ? n : '', ...notes].filter(Boolean).join(' · ');
  markPlaying();
}

function select(i, audition = true) {
  if (!itemCount()) return;
  sel = Math.max(0, Math.min(itemCount() - 1, i));
  for (const li of ui.results.children) li.classList.toggle('sel', +li.dataset.i === sel);
  ui.results.children[sel]?.scrollIntoView({ block: 'nearest' });
  const item = itemAt(sel);
  if (item.app) stop();
  else if (audition) play(item);
}

// --- player -----------------------------------------------------------------------

const player = { ctx: null, src: null, row: null, buf: null, start: 0, req: 0, cache: new Map() };

async function load(row) {
  const hit = player.cache.get(row.id);
  if (hit) return hit;
  if (!player.ctx) player.ctx = new AudioContext({ latencyHint: 'interactive' });
  const bytes = await window.sm.readSample(row.id);
  const buf = await player.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  player.cache.set(row.id, buf);
  while (player.cache.size > CACHE) player.cache.delete(player.cache.keys().next().value);
  return buf;
}

function stop() {
  player.req++;
  if (player.src) {
    player.src.onended = null;
    try {
      player.src.stop();
    } catch {}
    player.src = null;
  }
  markPlaying();
}

async function play(row) {
  stop();
  const req = player.req;
  player.row = row;
  let buf;
  try {
    buf = await load(row);
  } catch {
    return;
  }
  if (req !== player.req) return; // moved on already
  if (player.ctx.state === 'suspended') await player.ctx.resume();
  const src = player.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(player.ctx.destination);
  src.onended = () => {
    if (player.src === src) {
      player.src = null;
      markPlaying();
    }
  };
  src.start();
  player.src = src;
  player.buf = buf;
  player.start = player.ctx.currentTime;
  if (row.durationMs == null) {
    row.durationMs = Math.round(buf.duration * 1000);
    window.sm.setDuration(row.id, row.durationMs);
  }
  markPlaying();
  tick();
}

function togglePlay() {
  if (player.src) stop();
  else if (itemAt(sel) && !itemAt(sel).app) play(itemAt(sel));
}

function markPlaying() {
  const id = player.src ? player.row?.id : null;
  for (const li of ui.results.children) li.classList.toggle('playing', id != null && itemAt(+li.dataset.i)?.id === id);
  drawWave();
}

// --- waveform strip -------------------------------------------------------------------

let peaks = null;
let peaksFor = null;

function drawWave() {
  const c = ui.wave;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(c.clientWidth * dpr)) {
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    peaksFor = null;
  }
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const buf = player.row && player.cache.get(player.row.id);
  if (!buf) return;
  if (peaksFor !== buf) {
    const W = c.width;
    peaks = new Float32Array(W);
    const ch = buf.getChannelData(0);
    const per = ch.length / W;
    for (let x = 0; x < W; x++) {
      let m = 0;
      const a = Math.floor(x * per);
      const b = Math.min(ch.length, Math.floor((x + 1) * per));
      const step = Math.max(1, Math.floor((b - a) / 128));
      for (let i = a; i < b; i += step) m = Math.max(m, Math.abs(ch[i]));
      peaks[x] = m;
    }
    peaksFor = buf;
  }
  const mid = c.height / 2;
  const pos = player.src ? (player.ctx.currentTime - player.start) / buf.duration : 0;
  for (let x = 0; x < c.width; x++) {
    g.fillStyle = player.src && x / c.width < pos ? '#ffaa3c' : '#4a4f5a';
    const h = Math.max(1, peaks[x] * mid * 0.95);
    g.fillRect(x, mid - h, 1, h * 2);
  }
}

function tick() {
  if (!player.src) return drawWave();
  drawWave();
  requestAnimationFrame(tick);
}

ui.wave.addEventListener('mousedown', (e) => {
  const buf = player.row && player.cache.get(player.row.id);
  if (!buf) return;
  const r = ui.wave.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * buf.duration;
  stop();
  const src = player.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(player.ctx.destination);
  src.onended = () => {
    if (player.src === src) {
      player.src = null;
      markPlaying();
    }
  };
  src.start(0, t);
  player.src = src;
  player.start = player.ctx.currentTime - t;
  markPlaying();
  tick();
});

// --- input ----------------------------------------------------------------------------

ui.q.addEventListener('input', () => {
  commitTags(false); // "#kick " → chip
  clearTimeout(timer);
  timer = setTimeout(search, 70);
});

ui.q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    select(sel + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    select(sel + (e.key === 'PageDown' ? 8 : -8));
  } else if ((e.key === 'Tab' || e.key === 'Enter') && /(^|\s)#\S+$/.test(ui.q.value)) {
    // Finish the "#tag" being typed as a chip (Tab, or ↵ before opening).
    e.preventDefault();
    if (commitTags(true)) search();
  } else if (e.key === 'Tab') {
    e.preventDefault();
  } else if (e.key === 'Backspace' && !ui.q.value && chipTags.length) {
    chipTags.pop();
    renderChips();
    search();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const r = itemAt(sel);
    if (r && r.app) window.sm.openMainWindow();
    else if (e.shiftKey) togglePlay();
    else if (r && (e.metaKey || e.ctrlKey)) window.sm.reveal(r.id);
    else if (r) {
      stop();
      window.sm.quickOpen(r.id, r.path);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (ui.q.value || chipTags.length) {
      // First Esc clears the search (text and chips), the next one closes.
      ui.q.value = '';
      chipTags = [];
      renderChips();
      search();
    } else window.sm.quickHide();
  }
});

// Mouse: click to audition, double-click to open, drag into the DAW.
// (No preventDefault on mousedown: it would also cancel the drag. Focus goes
// back to the search box on mouseup instead.)
ui.results.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) select(+li.dataset.i);
});
ui.results.addEventListener('mouseup', () => ui.q.focus());
ui.results.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const r = itemAt(+li.dataset.i);
  stop();
  if (r.app) window.sm.openMainWindow();
  else window.sm.quickOpen(r.id, r.path);
});
ui.results.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[data-i]');
  e.preventDefault();
  const r = li && itemAt(+li.dataset.i);
  if (r && !r.app) window.sm.startDrag([r.id]); // crops set in the main window apply here too
});

// --- show / hide -------------------------------------------------------------------------

window.sm.onQuickShown(async () => {
  ui.q.focus();
  ui.q.select(); // like Spotlight: last query kept, typing replaces it
  const t = await window.sm.listTags();
  tagNames = t.tags.map((x) => x.name);
  chipTags = chipTags.filter((c) => tagNames.includes(c)); // a tag may have been deleted
  if (!rows.length) search();
});
window.sm.onQuickHidden(stop);

search();
