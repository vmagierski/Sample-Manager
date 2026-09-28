const path = require('path');
const chokidar = require('chokidar');
const db = require('./db');
const scanner = require('./scanner');

// How long an unlinked file waits for a matching 'add' before we treat it as
// deleted. Must exceed awaitWriteFinish's stabilityThreshold, which delays
// every 'add' (including the second half of a rename).
const RENAME_WINDOW_MS = 3000;

// DB writes wait this long and then go in together, so a folder's worth of
// files arriving (or leaving) at once is one transaction and one update.
const FLUSH_MS = 100;

const statKey = (size, mtime) => `${size}:${mtime}`;

class LibraryWatcher {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.watchers = new Map(); // folderId -> FSWatcher
    this.pendingUnlinks = new Map(); // path -> { row, timer }
    this.unlinksByStat = new Map(); // statKey -> Set of paths in pendingUnlinks
    this.ops = []; // DB writes waiting for flush()
    this.flushTimer = null;
  }

  enqueue(op) {
    this.ops.push(op);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this.flushTimer = null;
    const ops = this.ops;
    this.ops = [];
    if (this.closed || !ops.length) return;
    db.batch(() => {
      for (const op of ops) {
        try {
          op();
        } catch (err) {
          console.warn('watcher:', err.message); // skip this file, keep the rest
        }
      }
    });
    this.onChange();
  }

  watch(folder) {
    if (this.watchers.has(folder.id)) return;
    const w = chokidar.watch(folder.path, {
      ignoreInitial: true,
      alwaysStat: true,
      followSymlinks: false,
      ignored: (p) => path.basename(p).startsWith('.') && p !== folder.path,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    });
    w.on('add', (p, st) => this.handleAdd(folder, p, st));
    w.on('change', (p, st) => this.handleAdd(folder, p, st));
    w.on('unlink', (p) => this.handleUnlink(p));
    w.on('unlinkDir', (p) => this.handleUnlinkDir(p));
    w.on('error', (err) => console.warn(`watcher (${folder.path}):`, err.message));
    this.watchers.set(folder.id, w);
  }

  async unwatch(folderId) {
    const w = this.watchers.get(folderId);
    this.watchers.delete(folderId);
    if (w) await w.close();
  }

  async closeAll() {
    this.closed = true; // ignore any events still in flight (the DB is closing)
    for (const { timer } of this.pendingUnlinks.values()) clearTimeout(timer);
    this.pendingUnlinks.clear();
    this.unlinksByStat.clear();
    clearTimeout(this.flushTimer);
    this.ops = []; // the next launch's rescan picks these up
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  handleAdd(folder, p, st) {
    if (this.closed || !scanner.isAudio(p) || !st || !st.isFile()) return;
    // Folder may have been removed while the event was in flight.
    if (!this.watchers.has(folder.id)) return;
    const file = { path: p, size: st.size, mtime: Math.round(st.mtimeMs) };
    const autoTags = scanner.tagsFor(path.relative(folder.path, p), p);

    this.dropUnlink(p); // deleted and written again (a save-over): it's still here
    const moved = this.takeMatchingUnlink(file);
    this.enqueue(() => {
      if (!this.watchers.has(folder.id)) return;
      if (moved && !db.hasPath(p)) {
        db.movePath(moved, p, folder.id, autoTags);
      } else {
        if (moved) db.removePath(moved); // moved over an existing file
        db.upsertFile(folder.id, file, autoTags);
      }
    });
  }

  handleUnlink(p) {
    if (this.closed || !scanner.isAudio(p)) return;
    const row = db.getByPath(p);
    if (!row) {
      this.enqueue(() => db.removePath(p)); // in case its add is still queued
      return;
    }
    // Finder renames/moves arrive as unlink + add. Hold the delete briefly so a
    // matching add can move the row instead, preserving its manual tags.
    const timer = setTimeout(() => {
      this.dropUnlink(p);
      this.enqueue(() => db.removePath(p));
    }, RENAME_WINDOW_MS);
    this.pendingUnlinks.set(p, { row, timer });
    const key = statKey(row.size_bytes, row.date_modified);
    if (!this.unlinksByStat.has(key)) this.unlinksByStat.set(key, new Set());
    this.unlinksByStat.get(key).add(p);
  }

  dropUnlink(p) {
    const pending = this.pendingUnlinks.get(p);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingUnlinks.delete(p);
    const key = statKey(pending.row.size_bytes, pending.row.date_modified);
    const set = this.unlinksByStat.get(key);
    set.delete(p);
    if (!set.size) this.unlinksByStat.delete(key);
  }

  handleUnlinkDir(dir) {
    if (this.closed) return;
    // chokidar also emits 'unlink' for each file inside, which goes through
    // the rename window above; this just catches anything it missed.
    setTimeout(() => {
      if (this.closed) return;
      const prefix = dir + path.sep;
      for (const p of this.pendingUnlinks.keys()) if (p.startsWith(prefix)) return;
      this.enqueue(() => db.removeDir(dir));
    }, RENAME_WINDOW_MS + 500);
  }

  // Match on size + mtime (both survive a rename). Prefer the same filename,
  // since sample packs often have many equal-length files with one mtime.
  // Looked up by size + mtime, so moving a big folder isn't quadratic.
  takeMatchingUnlink(file) {
    const candidates = [...(this.unlinksByStat.get(statKey(file.size, file.mtime)) || [])];
    const base = path.basename(file.path);
    let match = candidates.find((p) => path.basename(p) === base);
    if (!match && candidates.length === 1) match = candidates[0];
    if (!match) return null;
    this.dropUnlink(match);
    return match;
  }
}

module.exports = { LibraryWatcher };
