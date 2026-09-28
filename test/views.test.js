const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../src/main/db');

// The search index, stored counts and id-list views, checked against the
// plain-SQL versions they replaced (a full scan with LIKE, counted live).

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-views-'));
const file = path.join(dir, 'lib.db');
db.open(file);
const ref = new Database(file, { readonly: true });
test.after(() => {
  ref.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// The old listSamples query, ids only.
function oldIds(filter = {}) {
  const where = [];
  const params = [];
  const dirs = [...new Set(filter.dirs || [])];
  const browsing = (h) => dirs.some((d) => d === h || d.startsWith(h + '/'));
  for (const h of db.listHidden().filter((h) => !browsing(h))) {
    where.push('NOT (s.path >= ? AND s.path < ?)');
    params.push(h + '/', h + '0');
  }
  if (dirs.length) {
    where.push(`(${dirs.map(() => '(s.path >= ? AND s.path < ?)').join(' OR ')})`);
    for (const d of dirs) params.push(d + '/', d + '0');
  }
  const tags = [...new Set(filter.tags || [])];
  if (tags.length) {
    where.push(`s.id IN (SELECT st.sample_id FROM sample_tags st JOIN tags t ON t.id = st.tag_id
                         WHERE t.name IN (${tags.map(() => '?').join(',')}) GROUP BY st.sample_id HAVING count(*) = ?)`);
    params.push(...tags, tags.length);
  }
  if (filter.untagged) where.push('NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id)');
  const terms = String(filter.search || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    where.push(`(substr(s.path, length(f.path) + 2) LIKE ? ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM sample_tags st JOIN tags t ON t.id = st.tag_id
                            WHERE st.sample_id = s.id AND t.name LIKE ? ESCAPE '\\'))`);
    params.push(like, like);
  }
  let order = 's.filename COLLATE NOCASE, s.path';
  if (filter.rank && terms.length) {
    const L = escapeLike;
    const phrase = terms.join(' ');
    const wordStart = () => `(s.filename LIKE ? ESCAPE '\\' OR s.filename LIKE ? ESCAPE '\\' OR s.filename LIKE ? ESCAPE '\\' OR s.filename LIKE ? ESCAPE '\\')`;
    const wordStartParams = (t) => [`${L(t)}%`, `% ${L(t)}%`, `%\\_${L(t)}%`, `%-${L(t)}%`];
    order = [
      `(${terms.map(() => "(s.filename LIKE ? ESCAPE '\\')").join(' + ')}) DESC`,
      "(s.filename LIKE ? ESCAPE '\\') DESC",
      `${wordStart()} DESC`,
      "(s.filename LIKE ? ESCAPE '\\') DESC",
      `(${terms.map(() => wordStart()).join(' + ')}) DESC`,
      'length(s.filename)',
      order,
    ].join(', ');
    params.push(...terms.map((t) => `%${L(t)}%`), `${L(phrase)}.%`, ...wordStartParams(phrase), `%${L(phrase)}%`, ...terms.flatMap(wordStartParams));
  }
  return ref
    .prepare(`SELECT s.id FROM samples s JOIN folders f ON f.id = s.folder_id
              ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`)
    .pluck()
    .all(...params);
}

// A small library with the awkward cases: shared prefixes, punctuation,
// short and multi-word names, tags with spaces, deep folders.
const WORDS = ['kick', 'Kick', 'snare', 'hh', 'HiHat', 'fx', 'Pad', 'dark', 'white noise', 'Noise', 'loop', 'Loops', 'a', 'x', '808', '100%', 'dry_wet', 'rise-up', 'Ölf', 'Bass'];
const DIRS = ['Drums', 'Drums/Kicks', 'Drums/Kick Loops', 'Pads', 'FX/Risers', 'Misc', 'Misc/fx', 'Vocals'];
function build() {
  let seed = 7;
  const rnd = (n) => {
    seed = (seed * 16807) % 2147483647;
    return seed % n;
  };
  const folder = db.addFolder('/lib', 'lib');
  const files = [];
  for (let i = 0; i < 400; i++) {
    const words = Array.from({ length: 1 + rnd(3) }, () => WORDS[rnd(WORDS.length)]);
    const ext = ['wav', 'aif', 'caf'][rnd(3)];
    files.push({ path: `/lib/${DIRS[rnd(DIRS.length)]}/${words.join(rnd(2) ? ' ' : '_')} ${i}.${ext}`, size: i, mtime: 1 });
  }
  files.push({ path: '/lib/Misc/white noise.wav', size: 1, mtime: 1 }, { path: '/lib/Misc/White Noise.aif', size: 1, mtime: 1 });
  const tagsFor = (p) => {
    const out = [];
    if (/kick/i.test(p)) out.push('kick');
    if (/pad/i.test(p)) out.push('pad');
    if (/loop/i.test(p)) out.push('loop');
    if (/fx|rise/i.test(p)) out.push('sound fx');
    return out;
  };
  db.syncFolder(folder.id, files, tagsFor);
  return folder;
}

const FILTERS = [
  {},
  { rank: true },
  { search: 'kick', rank: true },
  { search: 'kick' },
  { search: 'KICK loop', rank: true },
  { search: 'white noise', rank: true },
  { search: 'noise white', rank: true },
  { search: 'hh', rank: true },
  { search: 'a', rank: true },
  { search: 'x fx', rank: true },
  { search: '8', rank: true },
  { search: '100%', rank: true },
  { search: '_w', rank: true },
  { search: 'dry_wet', rank: true },
  { search: 'p-u', rank: true },
  { search: 'zz', rank: true },
  { search: 'sound', rank: true }, // a tag with a space
  { search: 'd f', rank: true }, // short terms, each on its own ("sound fx" as a tag)
  { search: 'kicks/', rank: true }, // folder names count
  { tags: ['kick'] },
  { tags: ['kick', 'loop'] },
  { tags: ['kick', 'nope'] },
  { untagged: true },
  { dirs: ['/lib/Drums'] },
  { dirs: ['/lib/Drums', '/lib/Drums/Kicks'] },
  { dirs: ['/lib/Misc'], search: 'fx', rank: true },
  { dirs: ['/lib/Pads'], tags: ['pad'], search: 'dark', rank: true },
];

function same(label) {
  for (const f of FILTERS) {
    assert.deepStrictEqual(Array.from(db.listIds(f).ids), oldIds(f), `${label}: ${JSON.stringify(f)}`);
  }
}

// Stored counts vs counted live.
function countsMatch(label) {
  const hidden = db.listHidden();
  const notHidden = (col) => hidden.map((h) => `NOT (${col} >= '${h}/' AND ${col} < '${h}0')`).join(' AND ') || '1';
  const live = ref
    .prepare(`SELECT t.name, (SELECT count(*) FROM sample_tags st JOIN samples s ON s.id = st.sample_id
                              WHERE st.tag_id = t.id AND ${notHidden('s.path')}) AS count FROM tags t ORDER BY t.name`)
    .all();
  const untagged = ref
    .prepare(`SELECT count(*) FROM samples s WHERE NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id) AND ${notHidden('s.path')}`)
    .pluck()
    .get();
  assert.deepStrictEqual(db.listTags(), { tags: live, untagged }, `${label}: tag counts`);
  assert.strictEqual(db.listIds({}).total, ref.prepare(`SELECT count(*) FROM samples WHERE ${notHidden('path')}`).pluck().get(), `${label}: total`);
  const dirs = new Map();
  for (const { path: p, folderId } of ref.prepare('SELECT path, folder_id AS folderId FROM samples').all()) {
    const key = `${folderId}|${p.slice(0, p.lastIndexOf('/'))}`;
    dirs.set(key, (dirs.get(key) || 0) + 1);
  }
  const stored = new Map(db.listDirs().dirs.map((d) => [`${d.folderId}|${d.dir}`, d.n]));
  assert.deepStrictEqual(stored, dirs, `${label}: dir counts`);
}

test('views match the old full-scan query, through every kind of change', () => {
  const folder = build();
  same('fresh');
  countsMatch('fresh');
  // One difference, on purpose: case doesn't matter beyond ASCII either (LIKE only folded A–Z).
  assert.ok(db.listIds({ search: 'ölf' }).ids.length > 0);
  assert.strictEqual(oldIds({ search: 'ölf' }).length, 0);

  // Tag edits, including a tag with a space.
  const some = db.listIds({ search: 'kick' }).ids;
  db.setTags(some[0], ['my projects', 'kick']);
  db.setTags(some[1], []);
  same('tag edits');
  countsMatch('tag edits');
  assert.deepStrictEqual(Array.from(db.listIds({ search: 'projects' }).ids), [some[0]]);

  // Rename / move (the watcher's path): old name gone, new one found.
  const row = db.getById(some[2]);
  db.movePath(row.path, '/lib/Vocals/Renamed Thing.wav', folder.id, []);
  same('rename');
  countsMatch('rename');
  assert.deepStrictEqual(Array.from(db.listIds({ search: 'renamed' }).ids), [some[2]]);

  // New rules: everything re-tagged.
  const files = ref.prepare('SELECT path, size_bytes AS size, date_modified AS mtime FROM samples').all();
  db.syncFolder(folder.id, files, (p) => (/snare/i.test(p) ? ['snare'] : []), { rulesHash: 'other' });
  same('retag');
  countsMatch('retag');

  // Deleting a tag takes it out of the index too.
  db.deleteTag('snare');
  same('delete tag');
  countsMatch('delete tag');
  assert.strictEqual(db.listIds({ search: 'snare' }).ids.length, oldIds({ search: 'snare' }).length);

  // Hidden folders: left out, unless browsed.
  db.hideDir('/lib/Drums');
  db.hideDir('/lib/Drums/Kicks'); // inside another hidden one
  same('hidden');
  countsMatch('hidden');
  db.unhideDir('/lib/Drums/Kicks');
  db.unhideDir('/lib/Drums');

  // Files removed, a directory removed, files added.
  db.removePath(files[0].path);
  db.removeDir('/lib/FX');
  db.upsertFile(folder.id, { path: '/lib/New/kick fresh.wav', size: 1, mtime: 1 }, ['kick']);
  same('add / remove');
  countsMatch('add / remove');

  // A parent folder absorbing this one: paths below the folder change.
  const parent = db.addFolder('/', 'root');
  const all = ref.prepare('SELECT path, size_bytes AS size, date_modified AS mtime FROM samples').all();
  db.syncFolder(parent.id, all, () => []);
  db.removeFolder(folder.id);
  same('absorbed');
  countsMatch('absorbed');
  const moved = db.listIds({ search: 'b/drums' }).ids; // the old folder's name is now part of the path below the folder
  assert.ok(moved.length > 0);
  assert.deepStrictEqual(Array.from(moved), oldIds({ search: 'b/drums' }));

  // Removing the folder empties the index.
  db.removeFolder(parent.id);
  countsMatch('removed');
  assert.strictEqual(ref.prepare('SELECT count(*) FROM sample_search').pluck().get(), 0);
  assert.strictEqual(db.listIds({ search: 'kick' }).ids.length, 0);
});

test('rows: by id, in the order asked, gone ids left out', () => {
  const f = db.addFolder('/r', 'r');
  db.syncFolder(f.id, ['b.wav', 'a.wav', 'c.wav'].map((n) => ({ path: `/r/${n}`, size: 1, mtime: 1 })), (p) => (p.endsWith('a.wav') ? ['x'] : []));
  const ids = Array.from(db.listIds({ dirs: ['/r'] }).ids);
  const rows = db.getRows([ids[2], 999999, ids[0]]);
  assert.deepStrictEqual(rows.map((r) => r.filename), ['c.wav', 'a.wav']);
  assert.deepStrictEqual(rows[1].tags, ['x']);
  assert.strictEqual(rows[1].relPath, 'a.wav');
  db.removeFolder(f.id);
});

test('an existing library gets the index, counts and name order when upgraded', () => {
  const old = path.join(dir, 'v1.db');
  const o = new Database(old);
  // A version-1 library, as the previous release left it.
  o.exec(`
    CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, label TEXT, rules_hash TEXT);
    CREATE TABLE samples (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, filename TEXT NOT NULL, folder_id INTEGER NOT NULL,
      size_bytes INTEGER, duration_ms INTEGER, format TEXT, date_added INTEGER, date_modified INTEGER, tags_edited INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE sample_tags (sample_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (sample_id, tag_id));
    CREATE INDEX idx_sample_tags_tag ON sample_tags(tag_id);
    CREATE TABLE hidden_dirs (path TEXT PRIMARY KEY);
    INSERT INTO folders VALUES (1, '/o', 'o', NULL);
    INSERT INTO samples (id, path, filename, folder_id) VALUES (1, '/o/a/Kick 1.wav', 'Kick 1.wav', 1), (2, '/o/b/pad.wav', 'pad.wav', 1), (3, '/o/b/fx.wav', 'fx.wav', 1);
    INSERT INTO tags VALUES (1, 'kick'), (2, 'unused');
    INSERT INTO sample_tags VALUES (1, 1, 'auto');
    PRAGMA user_version = 1;`);
  o.close();
  db.close();
  db.open(old);
  assert.deepStrictEqual(db.listTags(), { tags: [{ name: 'kick', count: 1 }, { name: 'unused', count: 0 }], untagged: 2 });
  assert.deepStrictEqual(db.listDirs().dirs.map((d) => [d.dir, d.n]).sort(), [['/o/a', 1], ['/o/b', 2]]);
  assert.deepStrictEqual(db.listSamples({ search: 'kick' }).rows.map((r) => r.filename), ['Kick 1.wav']);
  assert.deepStrictEqual(db.listSamples({ search: 'fx' }).rows.map((r) => r.filename), ['fx.wav']);
  assert.deepStrictEqual(db.listSamples({}).rows.map((r) => r.filename), ['fx.wav', 'Kick 1.wav', 'pad.wav']);
  // An older version opens it (setting user_version back, and adding a
  // sample without indexing it); the next open rebuilds everything.
  db.close();
  const back = new Database(old);
  back.exec(`PRAGMA user_version = 1;
    INSERT INTO samples (path, filename, folder_id) VALUES ('/o/c/Snare new.wav', 'Snare new.wav', 1);`);
  back.close();
  db.open(old);
  assert.deepStrictEqual(db.listSamples({ search: 'snare' }).rows.map((r) => r.filename), ['Snare new.wav']);
  assert.deepStrictEqual(db.listDirs().dirs.map((d) => [d.dir, d.n]).sort(), [['/o/a', 1], ['/o/b', 2], ['/o/c', 1]]);
  assert.strictEqual(db.listTags().untagged, 3);
  db.close();
  db.open(file);
});
