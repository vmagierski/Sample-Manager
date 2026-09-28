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
CREATE INDEX IF NOT EXISTS idx_sample_tags_tag ON sample_tags(tag_id, sample_id);

-- Folders (any level) hidden from the view. Still indexed and watched; just
-- excluded from lists, search, tag counts and Random.
CREATE TABLE IF NOT EXISTS hidden_dirs (
  path TEXT PRIMARY KEY
);
`;

// The search index and stored counts, so a search or the tag list never has
// to read the whole library:
// - sample_search: every sample's path below its watched folder and its tags,
//   as trigrams (any substring of 3+ characters is an index lookup; shorter
//   ones go through the index's vocabulary, see searchMatch). Each column
//   ends in two newlines — no search term holds one — so every character of
//   the real text starts a trigram. Rows are written by indexSample; deleting
//   a sample deletes its row (trigger).
// - tags.n, counters: samples per tag, samples, samples with any tag (triggers).
// - dir_counts: samples per directory, for the folder tree (see changedFile).
// - idx_samples_name: the default order, name then path (see nameOrder).
// - idx_sample_tags_tag, now with the sample: a tag's samples from the index alone.
const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE sample_search USING fts5(rel, tags, tokenize = 'trigram', content = '', contentless_delete = 1);
CREATE TABLE counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE dir_counts (
  folder_id INTEGER NOT NULL,
  dir TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (folder_id, dir)
) WITHOUT ROWID;
ALTER TABLE tags ADD COLUMN n INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_samples_name ON samples(filename COLLATE NOCASE, path);
DROP INDEX idx_sample_tags_tag; -- was on tag_id alone: a tag's samples straight from the index
CREATE INDEX idx_sample_tags_tag ON sample_tags(tag_id, sample_id);

CREATE TRIGGER samples_counted AFTER INSERT ON samples BEGIN
  UPDATE counters SET n = n + 1 WHERE name = 'samples';
END;
CREATE TRIGGER samples_uncounted AFTER DELETE ON samples BEGIN
  UPDATE counters SET n = n - 1 WHERE name = 'samples';
  DELETE FROM sample_search WHERE rowid = OLD.id;
END;
CREATE TRIGGER sample_tags_counted AFTER INSERT ON sample_tags BEGIN
  UPDATE tags SET n = n + 1 WHERE id = NEW.tag_id;
  UPDATE counters SET n = n + 1 WHERE name = 'tagged'
    AND (SELECT count(*) FROM sample_tags WHERE sample_id = NEW.sample_id) = 1;
END;
CREATE TRIGGER sample_tags_uncounted AFTER DELETE ON sample_tags BEGIN
  UPDATE tags SET n = n - 1 WHERE id = OLD.tag_id;
  UPDATE counters SET n = n - 1 WHERE name = 'tagged'
    AND NOT EXISTS (SELECT 1 FROM sample_tags WHERE sample_id = OLD.sample_id);
END;

UPDATE tags SET n = (SELECT count(*) FROM sample_tags WHERE tag_id = tags.id);
INSERT INTO counters VALUES
  ('samples', (SELECT count(*) FROM samples)),
  ('tagged', (SELECT count(DISTINCT sample_id) FROM sample_tags));
INSERT INTO dir_counts SELECT folder_id, sm_dirname(path), count(*) FROM samples GROUP BY 1, 2;
`;

// One sample's search row (see SEARCH_SCHEMA), for the samples matching WHERE.
const searchRows = (where) => `
  INSERT INTO sample_search (rowid, rel, tags)
  SELECT s.id, substr(s.path, length(f.path) + 2) || char(10, 10),
         coalesce((SELECT group_concat(t.name, char(10)) FROM sample_tags st JOIN tags t ON t.id = st.tag_id
                   WHERE st.sample_id = s.id), '') || char(10, 10)
  FROM samples s JOIN folders f ON f.id = s.folder_id ${where}`;

// Upgrades for libraries made by older versions, by PRAGMA user_version.
// SQL, or a function of the database.
const MIGRATIONS = [
  // 1: tag rules the folder was last tagged with (see syncFolder).
  'ALTER TABLE folders ADD COLUMN rules_hash TEXT',
  // 2: search index, stored counts, name order.
  SEARCH_SCHEMA + searchRows(''),
];

let db;
let q;

const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));

function open(file) {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.function('sm_dirname', { deterministic: true }, dirOf);
  db.exec(SCHEMA);
  const version = db.pragma('user_version', { simple: true });
  // A new library gets the columns from SCHEMA only through migrations, so
  // every step runs on it too.
  db.transaction(() => {
    for (let v = version; v < MIGRATIONS.length; v++) {
      if (typeof MIGRATIONS[v] === 'function') MIGRATIONS[v](db);
      else db.exec(MIGRATIONS[v]);
    }
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
  // The index's vocabulary (every trigram in it), for 1–2 character terms.
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_vocab USING fts5vocab(main, 'sample_search', 'row')");
  changes = newChanges();
  dropViewCaches();

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
    counter: db.prepare('SELECT n FROM counters WHERE name = ?').pluck(),
    idsUnderDir: db.prepare('SELECT id FROM samples WHERE path >= ? AND path < ?').pluck(),
    nameOrder: db.prepare('SELECT id FROM samples ORDER BY filename COLLATE NOCASE, path').pluck(),
    idsInFolder: db.prepare('SELECT id FROM samples WHERE folder_id = ?').pluck(),
    idsWithTag: db.prepare('SELECT sample_id FROM sample_tags WHERE tag_id = (SELECT id FROM tags WHERE name = ?)').pluck(),
    idsUntagged: db.prepare('SELECT id FROM samples s WHERE NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id)').pluck(),
    searchIds: db.prepare('SELECT rowid FROM sample_search WHERE sample_search MATCH ?').pluck(),
    searchNames: db.prepare(`
      SELECT s.id, s.filename FROM sample_search JOIN samples s ON s.id = sample_search.rowid
      WHERE sample_search MATCH ?`).raw(),
    maxId: db.prepare('SELECT max(id) FROM samples').pluck(),
    rows: db.prepare(`
      SELECT s.id, s.path, s.filename, s.folder_id AS folderId, s.duration_ms AS durationMs, s.format, s.size_bytes AS size,
             substr(s.path, length(f.path) + 2) AS relPath,
             (SELECT group_concat(name, '${SEP}') FROM (
                SELECT t.name FROM sample_tags st JOIN tags t ON t.id = st.tag_id
                WHERE st.sample_id = s.id ORDER BY t.name)) AS tags
      FROM samples s JOIN folders f ON f.id = s.folder_id
      WHERE s.id IN (SELECT value FROM json_each(?))`),
    searchDelete: db.prepare('DELETE FROM sample_search WHERE rowid = ?'),
    searchInsert: db.prepare(searchRows('WHERE s.id = ?')),
    vocab: db.prepare('SELECT term FROM temp.search_vocab WHERE term >= ? AND term < ?').pluck(),
    dirCount: db.prepare(`
      INSERT INTO dir_counts (folder_id, dir, n) VALUES (?, ?, ?)
      ON CONFLICT (folder_id, dir) DO UPDATE SET n = n + excluded.n`),
    dirCountGone: db.prepare('DELETE FROM dir_counts WHERE folder_id = ? AND dir = ? AND n <= 0'),
    dirCounts: db.prepare('SELECT folder_id AS folderId, dir, n FROM dir_counts'),
    deleteFolderDirs: db.prepare('DELETE FROM dir_counts WHERE folder_id = ?'),
    tagSamples: db.prepare('SELECT sample_id FROM sample_tags WHERE tag_id = ?').pluck(),

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
    tagCounts: db.prepare('SELECT name, n AS count FROM tags ORDER BY name'),
    listHidden: db.prepare('SELECT path FROM hidden_dirs ORDER BY path'),
    hide: db.prepare('INSERT OR IGNORE INTO hidden_dirs (path) VALUES (?)'),
    unhide: db.prepare('DELETE FROM hidden_dirs WHERE path = ?'),
    unhideUnder: db.prepare('DELETE FROM hidden_dirs WHERE path = ? OR (path >= ? AND path < ?)'),
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
// Bumps on every write, so caches of counts can tell they're stale.
let writes = 0;

function newChanges() {
  return { all: false, dirs: new Map(), from: 0, to: 0 };
}

function bump() {
  seq++;
  writes++;
  if (!changes.from) changes.from = seq;
  changes.to = seq;
}

// Every sample added to (+1), removed from (-1) or updated in (0) a directory
// passes through here — which also keeps dir_counts and the name order current.
function changedFile(folderId, p, delta) {
  const dir = dirOf(p);
  const key = folderId + '\0' + dir;
  const hit = changes.dirs.get(key);
  if (hit) hit.delta += delta;
  else changes.dirs.set(key, { folderId, dir, delta });
  if (delta) {
    q.dirCount.run(folderId, dir, delta);
    if (delta < 0) q.dirCountGone.run(folderId, dir);
    dropViewCaches();
  }
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

// Rewrite a sample's search row: after anything that changes its path below
// its folder or its tags.
function indexSample(sampleId) {
  q.searchDelete.run(sampleId);
  q.searchInsert.run(sampleId);
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
  indexSample(sampleId);
  writes++;
  return q.sampleTags.all(sampleId).map((t) => t.name);
})();

// Directories that directly contain samples, with counts, for the folder tree,
// and the change number it's current as of (see takeChanges).
function listDirs() {
  return { dirs: q.dirCounts.all(), version: seq };
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
  const had = q.tagSamples.all(row.id);
  q.deleteTagLinks.run(row.id);
  q.deleteTag.run(row.id);
  for (const id of had) indexSample(id);
  changedAll();
  return true;
})();

// Hidden folders not inside another hidden folder.
function outermostHidden() {
  const hidden = listHidden();
  return hidden.filter((h) => !hidden.some((o) => h.startsWith(o + '/')));
}

// Counts leave out hidden folders: the stored counts minus those of the
// samples in hidden folders, which the path index finds directly. That part
// is kept until the next write.
let hiddenTagCounts = null; // { key, minus: Map(name -> n), untagged }

function listTags() {
  const tags = q.tagCounts.all();
  let untagged = q.counter.get('samples') - q.counter.get('tagged');
  const hidden = outermostHidden();
  if (hidden.length) {
    const key = writes + '\0' + hidden.join('\0');
    if (hiddenTagCounts?.key !== key) {
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
      const hiddenUntagged = db
        .prepare(`SELECT count(*) AS n FROM samples s
                  WHERE ${inHidden} AND NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id)`)
        .get(...params).n;
      hiddenTagCounts = { key, minus, untagged: hiddenUntagged };
    }
    for (const t of tags) t.count -= hiddenTagCounts.minus.get(t.name) || 0;
    untagged -= hiddenTagCounts.untagged;
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
  q.deleteFolderDirs.run(id);
  q.deleteFolder.run(id);
  dropViewCaches();
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
  indexSample(row.id);
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
// their auto tags are re-derived. rulesHash null = no rules could be loaded:
// leave unchanged rows' tags alone. Rows added after opts.startedAt (by the
// watcher, while the walk ran) aren't treated as gone.
//
// A generator: one transaction per step, so syncFolderAsync can yield to the
// event loop in between and a big library never blocks the main process long.
function* syncSteps(folderId, files, tagsFor, { rulesHash, startedAt = Infinity } = {}) {
  const retag = rulesHash !== null && (rulesHash === undefined || q.folderRulesHash.get(folderId)?.hash !== rulesHash);
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
          indexSample(row.id);
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
  if (rulesHash !== null) q.setRulesHash.run(rulesHash ?? null, folderId);
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
    indexSample(row.id);
    changedFile(prev.folderId, oldPath, -1);
    changedFile(folderId, newPath, 1);
  }
  return row;
})();

function setDuration(id, ms) {
  q.setDuration.run(Math.round(ms), id);
}

// --- views -----------------------------------------------------------------------
//
// A view — what a filter shows — is the ordered list of its sample ids; the
// rows themselves are fetched separately, only for what's on screen
// (getRows). Filters pick ids through indexes (path ranges, tags, the search
// index). Ordering uses the library's name order, kept in memory until a
// sample is added, removed or renamed: alphabetical is one pass over it, and
// ranking only reads the file names of what matched. The ids below the last
// few folders viewed or hidden are kept too (typing a search in a big folder
// shouldn't re-read the folder on every key).

let order = null; // { ids: Int32Array, pos: Int32Array (id -> position + 1) }
let folderIds = new Map(); // dir -> ids below it, most recently used last
let hiddenMasks = new Map(); // hidden folders (joined) -> { mask: Uint8Array by id, n }
const FOLDERS_KEPT = 8;

function dropViewCaches() {
  order = null;
  folderIds = new Map();
  hiddenMasks = new Map();
}

function idsUnder(dir) {
  let ids = folderIds.get(dir);
  if (ids) folderIds.delete(dir);
  else ids = q.idsUnderDir.all(...range(dir));
  folderIds.set(dir, ids);
  if (folderIds.size > FOLDERS_KEPT) folderIds.delete(folderIds.keys().next().value);
  return ids;
}

function nameOrder() {
  if (order) return order;
  const ids = Int32Array.from(q.nameOrder.all());
  const pos = new Int32Array((q.maxId.get() || 0) + 1);
  for (let i = 0; i < ids.length; i++) pos[ids[i]] = i + 1;
  order = { ids, pos };
  return order;
}

// The samples below these folders, as a mask by id (null for none).
function hiddenMask(dirs) {
  if (!dirs.length) return null;
  const key = dirs.join('\0');
  let hit = hiddenMasks.get(key);
  if (!hit) {
    const mask = new Uint8Array(nameOrder().pos.length);
    let n = 0;
    for (const d of dirs) {
      for (const id of idsUnder(d)) {
        if (!mask[id]) {
          mask[id] = 1;
          n++;
        }
      }
    }
    hit = { mask, n };
    hiddenMasks.set(key, hit);
  }
  return hit;
}

// Hidden folders a view leaves out — not a hidden folder you're explicitly
// browsing (or a folder inside one), which shows its contents.
function hiddenFor(browsingDirs) {
  const browsing = (h) => browsingDirs.some((d) => d === h || d.startsWith(h + '/'));
  return hiddenMask(listHidden().filter((h) => !browsing(h)));
}

const quote = (s) => '"' + s.replace(/"/g, '""') + '"';

// The first string after every string that starts with s.
function after(s) {
  const chars = [...s];
  const last = chars.pop();
  return chars.join('') + String.fromCodePoint(last.codePointAt(0) + 1);
}

// Search index query for "every term is in the path or a tag". A term of 3+
// characters is the phrase of its trigrams; a shorter one, any trigram that
// starts with it (from the index's vocabulary). Null if a term matches nothing.
function searchMatch(terms) {
  const parts = [];
  for (const t of terms) {
    if ([...t].length >= 3) {
      parts.push(quote(t));
      continue;
    }
    const grams = q.vocab.all(t, after(t));
    if (!grams.length) return null;
    parts.push(`(${grams.map(quote).join(' OR ')})`);
  }
  return parts.join(' AND ');
}

// What the filter matches, in no particular order: { ids } — null for
// "every sample" — plus, when ranking a search, { names }: each one's file
// name, lower-cased. Each filter gives a list of ids from an index (a path
// range, a tag, the search index); the result is the ids on every list.
function matchIds(filter, dirs, terms, rank) {
  const lists = [];

  // Any directory in the tree (a watched folder or a subfolder): everything below it.
  if (dirs.length) {
    const parts = dirs.map(idsUnder);
    lists.push(parts.length === 1 ? parts[0] : [...new Set(parts.flat())]); // selected folders can overlap
  }
  if (filter.folderId) lists.push(q.idsInFolder.all(filter.folderId));

  // Tag filter: AND — a sample must carry every selected tag.
  for (const tag of new Set((filter.tags || []).map(normalizeTag).filter(Boolean))) {
    lists.push(q.idsWithTag.all(tag));
  }
  if (filter.untagged) lists.push(q.idsUntagged.all());

  // Search: every term must match the path below the watched folder, or a tag.
  let names = null;
  if (terms.length) {
    const match = searchMatch(terms);
    if (match == null) return { ids: [], names: [] };
    if (rank) {
      const found = q.searchNames.all(match);
      lists.push(found.map((r) => r[0]));
      names = found.map((r) => r[1].toLowerCase());
    } else lists.push(q.searchIds.all(match));
  }

  if (!lists.length) return { ids: null, names: null };
  // Keep the search's list (the last) when ranking, so the names stay aligned;
  // otherwise the shortest.
  const [base, ...rest] = names ? [lists.pop(), ...lists] : lists.sort((a, b) => a.length - b.length);
  if (!rest.length) return { ids: base, names };
  const seen = new Uint8Array(nameOrder().pos.length);
  for (const list of rest) for (const id of list) seen[id]++;
  const ids = [];
  const kept = names ? [] : null;
  for (let i = 0; i < base.length; i++) {
    if (seen[base[i]] !== rest.length) continue;
    ids.push(base[i]);
    if (kept) kept.push(names[i]);
  }
  return { ids, names: kept };
}

// These ids (null: all) in name order, less the hidden ones: a mark per
// position, then one pass over the order.
function byName(ids, hidden) {
  const o = nameOrder();
  if (!ids) return hidden ? o.ids.filter((id) => !hidden.mask[id]) : o.ids;
  const mark = new Uint8Array(o.ids.length);
  let n = 0;
  for (const id of ids) {
    const p = o.pos[id];
    if (!p || (hidden && hidden.mask[id])) continue;
    mark[p - 1] = 1;
    n++;
  }
  const out = new Int32Array(n);
  for (let i = 0, j = 0; j < n; i++) if (mark[i]) out[j++] = o.ids[i];
  return out;
}

// Ranked search: samples whose *file name* contains more of the search
// words come before ones that only match through a folder or tag name;
// then the name *is* the search ("white noise" → white noise.wav), then
// it holds the words as a phrase at a word start (Clap White Noise.wav),
// anywhere, more words at word starts, shorter names, then alphabetical.
// Each sample's place is packed into one number, so it's a numeric sort.
function byRank(ids, names, hidden, terms) {
  const o = nameOrder();
  const phrase = terms.join(' ');
  const wordStart = (name, t) => name.startsWith(t) || name.includes(' ' + t) || name.includes('_' + t) || name.includes('-' + t);
  const T = terms.length + 1;
  const best = 8 * T * T; // above any score
  const P = o.ids.length + 1;
  const keys = new Float64Array(ids.length);
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    const p = o.pos[ids[i]];
    if (!p || (hidden && hidden.mask[ids[i]])) continue;
    const name = names[i];
    let hits = 0;
    let starts = 0;
    for (const t of terms) {
      if (!name.includes(t)) continue;
      hits++;
      if (wordStart(name, t)) starts++;
    }
    let score = hits;
    if (hits) {
      score = score * 2 + (name.startsWith(phrase + '.') ? 1 : 0); // the whole name, any extension
      score = score * 2 + (wordStart(name, phrase) ? 1 : 0);
      score = score * 2 + (name.includes(phrase) ? 1 : 0);
    } else score *= 8; // none of the words: no phrase either
    score = score * T + starts;
    keys[n++] = ((best - score) * 1024 + Math.min(name.length, 1023)) * P + (p - 1);
  }
  const sorted = keys.subarray(0, n).sort();
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = o.ids[sorted[i] % P];
  return out;
}

// Everything not hidden: what an unfiltered view would show.
function libraryTotal() {
  const h = hiddenMask(outermostHidden());
  return q.counter.get('samples') - (h ? h.n : 0);
}

// filter: { search, tags: string[], untagged: bool, dirs: string[], folderId,
//           rank: bool (best matches first while searching; else alphabetical) }
// → { ids: Int32Array in view order, total }
function listIds(filter = {}) {
  const dirs = [...new Set([].concat(filter.dirs || [], filter.dir || []))];
  const terms = String(filter.search || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hidden = hiddenFor(dirs);
  const rank = !!filter.rank && terms.length > 0;
  const matched = matchIds(filter, dirs, terms, rank);
  const ids = rank ? byRank(matched.ids, matched.names, hidden, terms) : byName(matched.ids, hidden);
  return { ids, total: libraryTotal() };
}

// Rows for these ids, in the same order. Ids no longer in the library are left out.
function getRows(ids) {
  const byId = new Map();
  for (const r of q.rows.all(JSON.stringify(Array.from(ids)))) {
    r.tags = r.tags ? r.tags.split(SEP) : [];
    byId.set(r.id, r);
  }
  const out = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) out.push(r);
  }
  return out;
}

// A view with its rows — the first `filter.limit`, or all of them. For Quick
// Search and tests; the main list fetches rows as they scroll into view.
function listSamples(filter = {}) {
  const { ids, total } = listIds(filter);
  const limit = Math.max(0, Math.floor(filter.limit || 0));
  return { rows: getRows(limit ? ids.subarray(0, limit) : ids), total };
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
  listIds,
  getRows,
  dropViewCaches,
  normalizeTag,
};
