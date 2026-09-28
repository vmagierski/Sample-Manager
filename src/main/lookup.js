const Database = require('better-sqlite3');

// Main's own read-only view of the library, for the few quick lookups it
// needs on the spot — a drag, a context menu, Show in Finder. Point queries
// on indexed columns only; anything heavier (and every write) goes to the
// library worker. WAL mode lets this read while the worker writes.

let file = null;
let db = null;
let q = null;

function open(dbFile) {
  file = dbFile;
}

// Opened on first use: the worker creates the database (and its schema).
function stmts() {
  if (q) return q;
  if (!file) throw new Error('library lookup not configured');
  db = new Database(file, { readonly: true, fileMustExist: true });
  q = {
    getById: db.prepare('SELECT id, path, filename, folder_id FROM samples WHERE id = ?'),
    getFolder: db.prepare('SELECT id, path, label FROM folders WHERE id = ?'),
    listFolders: db.prepare('SELECT id, path, label FROM folders ORDER BY label COLLATE NOCASE'),
    listHidden: db.prepare('SELECT path FROM hidden_dirs ORDER BY path'),
  };
  return q;
}

function safe(fn, fallback) {
  try {
    return fn(stmts());
  } catch (err) {
    console.warn('lookup:', err.message);
    return fallback;
  }
}

const getById = (id) => safe((s) => s.getById.get(id), undefined);
const getFolder = (id) => safe((s) => s.getFolder.get(id), undefined);
const listFolders = () => safe((s) => s.listFolders.all(), []);
const listHidden = () => safe((s) => s.listHidden.all().map((r) => r.path), []);

function close() {
  if (db) db.close();
  db = null;
  q = null;
}

module.exports = { open, close, getById, getFolder, listFolders, listHidden };
