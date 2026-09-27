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

let db;
let q;

function open(file) {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  q = {
    listFolders: db.prepare('SELECT id, path, label FROM folders ORDER BY label COLLATE NOCASE'),
    getFolder: db.prepare('SELECT id, path, label FROM folders WHERE id = ?'),
    insertFolder: db.prepare('INSERT INTO folders (path, label) VALUES (?, ?) RETURNING id, path, label'),
    deleteFolder: db.prepare('DELETE FROM folders WHERE id = ?'),
    deleteFolderSamples: db.prepare('DELETE FROM samples WHERE folder_id = ?'),
    folderSampleIds: db.prepare('SELECT id FROM samples WHERE folder_id = ?'),

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
    getById: db.prepare('SELECT id, path, filename, folder_id, tags_edited FROM samples WHERE id = ?'),
    deleteByPath: db.prepare('DELETE FROM samples WHERE path = ?'),
    deleteById: db.prepare('DELETE FROM samples WHERE id = ?'),
    deleteUnderDir: db.prepare("DELETE FROM samples WHERE substr(path, 1, length(?) + 1) = ? || '/'"),
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
    unhideUnder: db.prepare("DELETE FROM hidden_dirs WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'"),
    untaggedCount: db.prepare(`
      SELECT count(*) AS n FROM samples s
      WHERE NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id)`),
  };
}

function close() {
  if (db) db.close();
  db = null;
}

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

// Directories that directly contain samples, with counts, for the folder tree.
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
  return [...counts.values()];
}

// --- hidden folders -----------------------------------------------------------

const listHidden = () => q.listHidden.all().map((r) => r.path);
const hideDir = (dir) => q.hide.run(dir);
const unhideDir = (dir) => q.unhide.run(dir);

// SQL excluding samples under hidden folders — except a hidden folder you're
// explicitly browsing (or a folder inside one), which shows its contents.
function hiddenClause(browsingDirs = []) {
  const browsing = (h) => browsingDirs.some((d) => d === h || d.startsWith(h + '/'));
  const hidden = listHidden().filter((h) => !browsing(h));
  return {
    sql: hidden.map(() => "substr(s.path, 1, length(?) + 1) != ? || '/'").join(' AND '),
    params: hidden.flatMap((h) => [h, h]),
  };
}

// Make sure these tags exist (e.g. every tag named in tag-rules.json), even
// before any sample has them.
const ensureTags = (names) => db.transaction(() => {
  for (const n of names.map(normalizeTag).filter(Boolean)) q.ensureTag.run(n);
})();

// Explicit removal: the tag and all its uses, manual and auto.
const deleteTag = (name) => db.transaction(() => {
  const row = q.tagId.get(normalizeTag(name));
  if (!row) return false;
  q.deleteTagLinks.run(row.id);
  q.deleteTag.run(row.id);
  return true;
})();

function listTags() {
  const h = hiddenClause();
  if (!h.sql) return { tags: q.tagCounts.all(), untagged: q.untaggedCount.get().n };
  const tags = db
    .prepare(`SELECT t.name, (SELECT count(*) FROM sample_tags st JOIN samples s ON s.id = st.sample_id
                              WHERE st.tag_id = t.id AND ${h.sql}) AS count
              FROM tags t ORDER BY t.name`)
    .all(...h.params);
  const untagged = db
    .prepare(`SELECT count(*) AS n FROM samples s
              WHERE NOT EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_id = s.id) AND ${h.sql}`)
    .get(...h.params).n;
  return { tags, untagged };
}

// --- folders --------------------------------------------------------------

const listFolders = () => q.listFolders.all();
const getFolder = (id) => q.getFolder.get(id);
const addFolder = (folderPath, label) => q.insertFolder.get(folderPath, label);

const removeFolder = (id) => db.transaction(() => {
  const f = q.getFolder.get(id);
  if (f) q.unhideUnder.run(f.path, f.path, f.path);
  q.deleteFolderSamples.run(id);
  q.deleteFolder.run(id);
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
  const row = q.upsertSample.get(sampleParams(folderId, file));
  if (!row.tags_edited) applyAutoTags(row.id, autoTags);
  return row.id;
}

const upsertFile = (folderId, file, autoTags) => db.transaction(() => upsertOne(folderId, file, autoTags))();

// Make the DB match a fresh walk of one folder: upsert everything found,
// re-derive auto tags, drop rows for files that no longer exist.
const syncFolder = (folderId, files, tagsFor) => db.transaction(() => {
  const seen = new Set();
  for (const file of files) seen.add(upsertOne(folderId, file, tagsFor(file.path)));
  for (const { id } of q.folderSampleIds.all(folderId)) {
    if (!seen.has(id)) q.deleteById.run(id);
  }
})();

const getByPath = (p) => q.getByPath.get(p);
const getById = (id) => q.getById.get(id);
const hasPath = (p) => !!q.getByPath.get(p);

const removePath = (p) => db.transaction(() => {
  q.deleteByPath.run(p);
})();

const removeDir = (dir) => db.transaction(() => {
  q.deleteUnderDir.run(dir, dir);
})();

// Rename/move detected by the watcher: keep the row (and its manual tags).
const movePath = (oldPath, newPath, folderId, autoTags) => db.transaction(() => {
  const row = q.movePath.get({
    oldPath,
    newPath,
    filename: path.basename(newPath),
    folderId,
    format: path.extname(newPath).slice(1).toLowerCase(),
  });
  if (row && !row.tags_edited) applyAutoTags(row.id, autoTags);
  return row;
})();

function setDuration(id, ms) {
  q.setDuration.run(Math.round(ms), id);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// filter: { search, tags: string[], untagged: bool, dirs: string[], folderId }
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
    where.push(`(${dirs.map(() => "substr(s.path, 1, length(?) + 1) = ? || '/'").join(' OR ')})`);
    for (const d of dirs) params.push(d, d);
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

  const sql = `
    SELECT s.id, s.path, s.filename, s.folder_id AS folderId, s.duration_ms AS durationMs, s.format,
           substr(s.path, length(f.path) + 2) AS relPath,
           (SELECT group_concat(name, '${SEP}') FROM (
              SELECT t.name FROM sample_tags st JOIN tags t ON t.id = st.tag_id
              WHERE st.sample_id = s.id ORDER BY t.name)) AS tags
    FROM samples s JOIN folders f ON f.id = s.folder_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.filename COLLATE NOCASE, s.path`;

  const rows = db.prepare(sql).all(...params);
  for (const r of rows) r.tags = r.tags ? r.tags.split(SEP) : [];
  // Total = everything not hidden (what an unfiltered view would show).
  const h = hiddenClause();
  const total = h.sql
    ? db.prepare(`SELECT count(*) AS n FROM samples s WHERE ${h.sql}`).get(...h.params).n
    : q.count.get().n;
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
  upsertFile,
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
