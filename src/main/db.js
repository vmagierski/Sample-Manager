const path = require('path');
const Database = require('better-sqlite3');

// Unit separator — can't appear in a tag name (see normalizeTag), so it's a
// safe delimiter for group_concat.
const SEP = '\x1f';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  label TEXT
);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  size_bytes INTEGER,
  duration_ms INTEGER,
  format TEXT,
  date_added INTEGER,
  date_modified INTEGER,
  -- Set once tags are edited by hand. A rescan then leaves this sample's tags
  -- alone, so an auto tag you removed doesn't come back.
  tags_edited INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_tags (
  sample_id INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  source TEXT NOT NULL,
  PRIMARY KEY (sample_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_samples_folder ON samples(folder_id);
CREATE INDEX IF NOT EXISTS idx_sample_tags_tag ON sample_tags(tag_id);

-- Folders (any level) hidden from the view. Still indexed and watched; just
-- excluded from lists, search, tag counts and Random.
CREATE TABLE IF NOT EXISTS hidden_dirs (
  path TEXT PRIMARY KEY
);
`;

// Upgrades for libraries made by older versions, by PRAGMA user_version.
const MIGRATIONS = [
  // 1: tag rules the folder was last tagged with (see syncFolder).
  'ALTER TABLE folders ADD COLUMN rules_hash TEXT',
];

let db;
let q;

function open(file) {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const version = db.pragma('user_version', { simple: true });
  // A new library gets the columns from SCHEMA only through migrations, so
  // every step runs on it too.
  db.transaction(() => {
    for (let v = version; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
  changes = newChanges();

  q = {
    listFolders: db.prepare('SELECT id, path, label FROM folders ORDER BY label COLLATE NOCASE'),
    getFolder: db.prepare('SELECT id, path, label FROM folders WHERE id = ?'),
    folderRulesHash: db.prepare('SELECT rules_hash AS hash FROM folders WHERE id = ?'),
    setRulesHash: db.prepare('UPDATE folders SET rules_hash = ? WHERE id = ?'),
    insertFolder: db.prepare('INSERT INTO folders (path, label) VALUES (?, ?) RETURNING id, path, label'),
    deleteFolder: db.prepare('DELETE FROM folders WHERE id = ?'),
    deleteFolderSamples: db.prepare('DELETE FROM samples WHERE folder_id = ?'),
    // One page of a folder's rows, for syncFolder (keyset: id > ?).
    folderRows: db.prepare(`
      SELECT id, path, size_bytes AS size, date_modified AS mtime, date_added AS added, tags_edited AS edited
      FROM samples WHERE folder_id = ? AND id > ? ORDER BY id LIMIT ?`),

    upsertSample: db.prepare(`
      INSERT INTO samples (path, filename, folder_id, size_bytes, format, date_added, date_modified)
      VALUES (@path, @filename, @folderId, @size, @format, @now, @mtime)
      ON CONFLICT(path) DO UPDATE SET
        folder_id = excluded.folder_id,
        duration_ms = CASE WHEN size_bytes IS excluded.size_bytes AND date_modified IS excluded.date_modified
                           THEN duration_ms ELSE NULL END,
        size_bytes = excluded.size_bytes,
        date_modified = excluded.date_modified
      RETURNING id, tags_edited`),
    getByPath: db.prepare('SELECT id, path, filename, folder_id, size_bytes, date_modified, tags_edited FROM samples WHERE path = ?'),
    folderIdByPath: db.prepare('SELECT folder_id AS folderId FROM samples WHERE path = ?'),
    getById: db.prepare('SELECT id, path, filename, folder_id, tags_edited FROM samples WHERE id = ?'),
    deleteByPath: db.prepare('DELETE FROM samples WHERE path = ?'),
    deleteByIdPath: db.prepare('DELETE FROM samples WHERE id = ? AND path = ?'),
    // Everything below a folder: path in [dir + '/', dir + '0') — '0' sorts
    // right after '/', so this is a range the path index can use.
    pathsUnderDir: db.prepare('SELECT path, folder_id AS folderId FROM samples WHERE path >= ? AND path < ?'),
    deleteUnderDir: db.prepare('DELETE FROM samples WHERE path >= ? AND path < ?'),
    movePath: db.prepare(`
      UPDATE samples SET path = @newPath, filename = @filename, folder_id = @folderId, format = @format
      WHERE path = @oldPath RETURNING id, tags_edited`),
    setDuration: db.prepare('UPDATE samples SET duration_ms = ? WHERE id = ?'),
    setEdited: db.prepare('UPDATE samples SET tags_edited = 1 WHERE id = ?'),
    count: db.prepare('SELECT count(*) AS n FROM samples'),
    allPaths: db.prepare('SELECT path, folder_id AS folderId FROM samples'),

    tagId: db.prepare('SELECT id FROM tags WHERE name = ?'),
    insertTag: db.prepare('INSERT INTO tags (name) VALUES (?) RETURNING id'),
    deleteAutoTags: db.prepare("DELETE FROM sample_tags WHERE sample_id = ? AND source = 'auto'"),
    deleteAllTags: db.prepare('DELETE FROM sample_tags WHERE sample_id = ?'),
    addSampleTag: db.prepare('INSERT OR IGNORE INTO sample_tags (sample_id, tag_id, source) VALUES (?, ?, ?)'),
    sampleTags: db.prepare(`
      SELECT t.name, st.source FROM sample_tags st JOIN tags t ON t.id = st.tag_id
      WHERE st.sample_id = ? ORDER BY t.name`),
    deleteTagLinks: db.prepare('DELETE FROM sample_tags WHERE tag_id = ?'),
    deleteTag: db.prepare('DELETE FROM tags WHERE id = ?'),
    ensureTag: db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)'),
    // Every tag, including ones no sample currently has (count 0) — tags only
    // go away when deleted on purpose (deleteTag).
    tagCounts: db.prepare(`
      SELECT t.name, count(st.sample_id) AS count FROM tags t LEFT JOIN sample_tags st ON st.tag_id = t.id
      GROUP BY t.id ORDER BY t.name`),
    listHidden: db.prepare('SELECT path FROM hidden_dirs ORDER BY path'),
    hide: db.prepare('INSERT OR IGNORE INTO hidden_dirs (path) VALUES (?)'),
    unhide: db.prepare('DELETE FROM hidden_dirs WHERE path = ?'),
    unhideUnder: db.prepare('DELETE FROM hidden_dirs WHERE path = ? OR (path >= ? AND path < ?)'),
    untaggedCount: db.prepare(`
      SELECT count(*) AS n FROM samples s
      WHERE NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id)`),
  };
}

function close() {
  if (db) db.close();
  db = null;
}

// Every write in one transaction (nested ones become savepoints).
const batch = (fn) => db.transaction(fn)();

// --- change log -----------------------------------------------------------
//
// What changed since the page last heard, so it can update just that:
// samples added (+1) / removed (-1) / updated (0) per directory, or `all`
// for anything broader (folders, hidden folders, tag rules). Each change
// gets a sequence number; listDirs reports the latest, so the page can tell
// which changes a fresh read already includes.

let seq = 0;
let changes = newChanges();

function newChanges() {
  return { all: false, dirs: new Map(), from: 0, to: 0 };
}

function bump() {
  seq++;
  if (!changes.from) changes.from = seq;
  changes.to = seq;
}

function changedFile(folderId, p, delta) {
  const dir = p.slice(0, p.lastIndexOf('/'));
  const key = folderId + '\0' + dir;
  const hit = changes.dirs.get(key);
  if (hit) hit.delta += delta;
  else changes.dirs.set(key, { folderId, dir, delta });
  bump();
}

function changedAll() {
  changes.all = true;
  bump();
}

// The changes so far (null if none), and start a new list.
function takeChanges() {
  if (!changes.to) return null;
  const c = changes;
  changes = newChanges();
  return { all: c.all, dirs: c.all ? [] : [...c.dirs.values()], from: c.from, to: c.to };
}

// SQL for "path is below dir", as a range the path index can use.
const under = (col) => `(${col} >= ? AND ${col} < ?)`;
const range = (dir) => [dir + '/', dir + '0'];

// --- tags -----------------------------------------------------------------

function normalizeTag(name) {
  return String(name).toLowerCase().replace(/[\x00-\x1f,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagIdFor(name) {
  const row = q.tagId.get(name);
  return row ? row.id : q.insertTag.get(name).id;
}

function applyAutoTags(sampleId, names) {
  q.deleteAutoTags.run(sampleId);
  for (const name of names) {
    const n = normalizeTag(name);
    if (n) q.addSampleTag.run(sampleId, tagIdFor(n), 'auto');
  }
}

const setTags = (sampleId, names) => db.transaction(() => {
  const current = new Map(q.sampleTags.all(sampleId).map((t) => [t.name, t.source]));
  const wanted = [...new Set(names.map(normalizeTag).filter(Boolean))];
  q.deleteAllTags.run(sampleId);
  for (const name of wanted) {
    // An auto tag you kept stays 'auto'; anything new is 'manual'.
    q.addSampleTag.run(sampleId, tagIdFor(name), current.get(name) === 'auto' ? 'auto' : 'manual');
  }
  q.setEdited.run(sampleId);
  return q.sampleTags.all(sampleId).map((t) => t.name);
})();

// Directories that directly contain samples, with counts, for the folder tree,
// and the change number it's current as of (see takeChanges).
// (Splitting in JS is ~5x faster than doing the dirname in SQL.)
function listDirs() {
  const counts = new Map();
  for (const { path: p, folderId } of q.allPaths.iterate()) {
    const dir = p.slice(0, p.lastIndexOf('/'));
    const key = folderId + '\0' + dir;
    const hit = counts.get(key);
    if (hit) hit.n++;
    else counts.set(key, { folderId, dir, n: 1 });
  }
  return { dirs: [...counts.values()], version: seq };
}

// --- hidden folders -----------------------------------------------------------

const listHidden = () => q.listHidden.all().map((r) => r.path);

function hideDir(dir) {
  q.hide.run(dir);
  changedAll();
}

function unhideDir(dir) {
  q.unhide.run(dir);
  changedAll();
}

// SQL excluding samples under hidden folders — except a hidden folder you're
// explicitly browsing (or a folder inside one), which shows its contents.
function hiddenClause(browsingDirs = []) {
  const browsing = (h) => browsingDirs.some((d) => d === h || d.startsWith(h + '/'));
  const hidden = listHidden().filter((h) => !browsing(h));
  return {
    sql: hidden.map(() => `NOT ${under('s.path')}`).join(' AND '),
    params: hidden.flatMap(range),
  };
}

// Make sure these tags exist (e.g. every tag named in tag-rules.json), even
// before any sample has them.
const ensureTags = (names) => db.transaction(() => {
  let added = 0;
  for (const n of names.map(normalizeTag).filter(Boolean)) added += q.ensureTag.run(n).changes;
  if (added) changedAll();
})();

// Explicit removal: the tag and all its uses, manual and auto.
const deleteTag = (name) => db.transaction(() => {
  const row = q.tagId.get(normalizeTag(name));
  if (!row) return false;
  q.deleteTagLinks.run(row.id);
  q.deleteTag.run(row.id);
  changedAll();
  return true;
})();

// Hidden folders not inside another hidden folder.
function outermostHidden() {
  const hidden = listHidden();
  return hidden.filter((h) => !hidden.some((o) => h.startsWith(o + '/')));
}

// Counts leave out hidden folders: all samples minus those in hidden
// folders, which the path index finds directly (cheaper than testing every
// sample against every hidden folder).
function listTags() {
  const tags = q.tagCounts.all();
  let untagged = q.untaggedCount.get().n;
  const hidden = outermostHidden();
  if (hidden.length) {
    const inHidden = `(${hidden.map(() => under('s.path')).join(' OR ')})`;
    const params = hidden.flatMap(range);
    const minus = new Map(
      db
        .prepare(`SELECT t.name, count(*) AS n FROM samples s
                  JOIN sample_tags st ON st.sample_id = s.id JOIN tags t ON t.id = st.tag_id
                  WHERE ${inHidden} GROUP BY t.id`)
        .all(...params)
        .map((r) => [r.name, r.n]),
    );
    for (const t of tags) t.count -= minus.get(t.name) || 0;
    untagged -= db
      .prepare(`SELECT count(*) AS n FROM samples s
                WHERE ${inHidden} AND NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id)`)
      .get(...params).n;
  }
  return { tags, untagged };
}

// --- folders --------------------------------------------------------------

const listFolders = () => q.listFolders.all();
const getFolder = (id) => q.getFolder.get(id);

function addFolder(folderPath, label) {
  changedAll();
  return q.insertFolder.get(folderPath, label);
}

const removeFolder = (id) => db.transaction(() => {
  const f = q.getFolder.get(id);
  if (f) q.unhideUnder.run(f.path, ...range(f.path));
  q.deleteFolderSamples.run(id);
  q.deleteFolder.run(id);
  changedAll();
})();

// --- samples --------------------------------------------------------------

function sampleParams(folderId, file) {
  return {
    path: file.path,
    filename: path.basename(file.path),
    folderId,
    size: file.size,
    format: path.extname(file.path).slice(1).toLowerCase(),
    now: Date.now(),
    mtime: file.mtime,
  };
}

// Upsert one file and (unless hand-edited) re-derive its auto tags.
function upsertOne(folderId, file, autoTags) {
  const prev = q.folderIdByPath.get(file.path);
  const row = q.upsertSample.get(sampleParams(folderId, file));
  if (!row.tags_edited) applyAutoTags(row.id, autoTags);
  if (prev && prev.folderId !== folderId) changedFile(prev.folderId, file.path, -1); // absorbed by a parent folder
  changedFile(folderId, file.path, prev && prev.folderId === folderId ? 0 : 1);
  return row.id;
}

const upsertFile = (folderId, file, autoTags) => db.transaction(() => upsertOne(folderId, file, autoTags))();

// Files per transaction in syncFolder.
const CHUNK = 2000;

// Make the DB match a fresh walk of one folder: add new files, update changed
// ones, drop rows for files that no longer exist. Files with the same size and
// mtime as last time aren't touched — unless the tag rules changed since this
// folder was last synced (opts.rulesHash; none given = always), in which case
// their auto tags are re-derived. Rows added after opts.startedAt (by the
// watcher, while the walk ran) aren't treated as gone.
//
// A generator: one transaction per step, so syncFolderAsync can yield to the
// event loop in between and a big library never blocks the main process long.
function* syncSteps(folderId, files, tagsFor, { rulesHash, startedAt = Infinity } = {}) {
  const retag = rulesHash === undefined || q.folderRulesHash.get(folderId)?.hash !== rulesHash;
  const known = new Map(); // path -> row, for this folder's rows not seen in the walk (yet)
  for (let last = 0; ; yield) {
    const page = q.folderRows.all(folderId, last, CHUNK * 10);
    for (const r of page) known.set(r.path, r);
    if (page.length < CHUNK * 10) break;
    last = page[page.length - 1].id;
  }

  let retagged = 0;
  for (let i = 0; i < files.length; i += CHUNK) {
    if (!q.getFolder.get(folderId)) return; // removed mid-sync
    batch(() => {
      for (const file of files.slice(i, i + CHUNK)) {
        const row = known.get(file.path);
        known.delete(file.path);
        if (!row || row.size !== file.size || row.mtime !== file.mtime) {
          upsertOne(folderId, file, tagsFor(file.path));
        } else if (retag && !row.edited) {
          applyAutoTags(row.id, tagsFor(file.path));
          retagged++;
        }
      }
    });
    yield;
  }

  const gone = [...known.values()].filter((r) => r.added < startedAt);
  for (let i = 0; i < gone.length; i += CHUNK) {
    batch(() => {
      for (const r of gone.slice(i, i + CHUNK)) {
        if (q.deleteByIdPath.run(r.id, r.path).changes) changedFile(folderId, r.path, -1);
      }
    });
    yield;
  }
  if (retagged) changedAll(); // auto tags may have changed anywhere
  q.setRulesHash.run(rulesHash ?? null, folderId);
}

// All at once, in one transaction (tests, small folders).
const syncFolder = (folderId, files, tagsFor, opts) => batch(() => {
  for (const _ of syncSteps(folderId, files, tagsFor, opts));
});

async function syncFolderAsync(folderId, files, tagsFor, opts) {
  for (const _ of syncSteps(folderId, files, tagsFor, opts)) await new Promise(setImmediate);
}

const getByPath = (p) => q.getByPath.get(p);
const getById = (id) => q.getById.get(id);
const hasPath = (p) => !!q.getByPath.get(p);

const removePath = (p) => db.transaction(() => {
  const row = q.folderIdByPath.get(p);
  if (row && q.deleteByPath.run(p).changes) changedFile(row.folderId, p, -1);
})();

const removeDir = (dir) => db.transaction(() => {
  const rows = q.pathsUnderDir.all(...range(dir));
  q.deleteUnderDir.run(...range(dir));
  for (const r of rows) changedFile(r.folderId, r.path, -1);
})();

// Rename/move detected by the watcher: keep the row (and its manual tags).
const movePath = (oldPath, newPath, folderId, autoTags) => db.transaction(() => {
  const prev = q.folderIdByPath.get(oldPath);
  const row = q.movePath.get({
    oldPath,
    newPath,
    filename: path.basename(newPath),
    folderId,
    format: path.extname(newPath).slice(1).toLowerCase(),
  });
  if (row && !row.tags_edited) applyAutoTags(row.id, autoTags);
  if (row) {
    changedFile(prev.folderId, oldPath, -1);
    changedFile(folderId, newPath, 1);
  }
  return row;
})();

function setDuration(id, ms) {
  q.setDuration.run(Math.round(ms), id);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// filter: { search, tags: string[], untagged: bool, dirs: string[], folderId,
//           rank: bool (file-name matches first), limit: number }
function listSamples(filter = {}) {
  const where = [];
  const params = [];

  // Folder filter: samples below ANY of the selected folders.
  const dirs = [...new Set([].concat(filter.dirs || [], filter.dir || []))];
  const hidden = hiddenClause(dirs);
  if (hidden.sql) {
    where.push(hidden.sql);
    params.push(...hidden.params);
  }

  // Any directory in the tree (a watched folder or a subfolder): everything below it.
  if (dirs.length) {
    where.push(`(${dirs.map(() => under('s.path')).join(' OR ')})`);
    for (const d of dirs) params.push(...range(d));
  }
  if (filter.folderId) {
    where.push('s.folder_id = ?');
    params.push(filter.folderId);
  }

  // Tag filter: AND — a sample must carry every selected tag.
  const tags = [...new Set((filter.tags || []).map(normalizeTag).filter(Boolean))];
  if (tags.length) {
    where.push(`s.id IN (SELECT st.sample_id FROM sample_tags st JOIN tags t ON t.id = st.tag_id
                         WHERE t.name IN (${tags.map(() => '?').join(',')})
                         GROUP BY st.sample_id HAVING count(*) = ?)`);
    params.push(...tags, tags.length);
  }
  if (filter.untagged) {
    where.push('NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id)');
  }

  // Search: every term must match the path below the watched folder, or a tag.
  const terms = String(filter.search || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    where.push(`(substr(s.path, length(f.path) + 2) LIKE ? ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM sample_tags st JOIN tags t ON t.id = st.tag_id
                            WHERE st.sample_id = s.id AND t.name LIKE ? ESCAPE '\\'))`);
    params.push(like, like);
  }

  // Ranked search: samples whose *file name* contains more of the search
  // words come before ones that only match through a folder or tag name;
  // then the name *is* the search ("white noise" → white noise.wav), then
  // it holds the words as a phrase at a word start (Clap White Noise.wav),
  // anywhere, then shorter names. Unranked: alphabetical.
  let order = 's.filename COLLATE NOCASE, s.path';
  if (filter.rank && terms.length) {
    const L = (t) => escapeLike(t);
    const phrase = terms.join(' ');
    const wordStart = (t) => `(s.filename LIKE ? ESCAPE '\\' OR s.filename LIKE ? ESCAPE '\\' OR s.filename LIKE ? ESCAPE '\\' OR s.filename LIKE ? ESCAPE '\\')`;
    const wordStartParams = (t) => [`${L(t)}%`, `% ${L(t)}%`, `%\\_${L(t)}%`, `%-${L(t)}%`];
    order = [
      `(${terms.map(() => "(s.filename LIKE ? ESCAPE '\\')").join(' + ')}) DESC`,
      "(s.filename LIKE ? ESCAPE '\\') DESC", // the whole name, any extension
      `${wordStart(phrase)} DESC`,
      "(s.filename LIKE ? ESCAPE '\\') DESC",
      `(${terms.map((t) => wordStart(t)).join(' + ')}) DESC`,
      'length(s.filename)',
      order,
    ].join(', ');
    params.push(
      ...terms.map((t) => `%${L(t)}%`),
      `${L(phrase)}.%`,
      ...wordStartParams(phrase),
      `%${L(phrase)}%`,
      ...terms.flatMap(wordStartParams),
    );
  }
  const limit = Math.max(0, Math.floor(filter.limit || 0));
  if (limit) order += ' LIMIT ?';

  const sql = `
    SELECT s.id, s.path, s.filename, s.folder_id AS folderId, s.duration_ms AS durationMs, s.format,
           substr(s.path, length(f.path) + 2) AS relPath,
           (SELECT group_concat(name, '${SEP}') FROM (
              SELECT t.name FROM sample_tags st JOIN tags t ON t.id = st.tag_id
              WHERE st.sample_id = s.id ORDER BY t.name)) AS tags
    FROM samples s JOIN folders f ON f.id = s.folder_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}`;
  if (limit) params.push(limit);

  const rows = db.prepare(sql).all(...params);
  for (const r of rows) r.tags = r.tags ? r.tags.split(SEP) : [];
  // Total = everything not hidden (what an unfiltered view would show).
  const hiddenDirs = outermostHidden();
  let total = q.count.get().n;
  if (hiddenDirs.length) {
    total -= db
      .prepare(`SELECT count(*) AS n FROM samples s WHERE ${hiddenDirs.map(() => under('s.path')).join(' OR ')}`)
      .get(...hiddenDirs.flatMap(range)).n;
  }
  return { rows, total };
}

module.exports = {
  open,
  close,
  listFolders,
  getFolder,
  addFolder,
  removeFolder,
  syncFolder,
  syncFolderAsync,
  upsertFile,
  batch,
  takeChanges,
  getByPath,
  getById,
  hasPath,
  removePath,
  removeDir,
  movePath,
  setDuration,
  setTags,
  listTags,
  listDirs,
  listHidden,
  ensureTags,
  deleteTag,
  hideDir,
  unhideDir,
  listSamples,
  normalizeTag,
};
