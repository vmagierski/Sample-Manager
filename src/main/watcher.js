const path = require('path');
const chokidar = require('chokidar');
const db = require('./db');
const scanner = require('./scanner');

// How long an unlinked file waits for a matching 'add' before we treat it as
// deleted. Must exceed awaitWriteFinish's stabilityThreshold, which delays
// every 'add' (including the second half of a rename).
const RENAME_WINDOW_MS = 3000;

class LibraryWatcher {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.watchers = new Map(); // folderId -> FSWatcher
    this.pendingUnlinks = new Map(); // path -> { row, timer }
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
    for (const { timer } of this.pendingUnlinks.values()) clearTimeout(timer);
    this.pendingUnlinks.clear();
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  handleAdd(folder, p, st) {
    if (!scanner.isAudio(p) || !st || !st.isFile()) return;
    // Folder may have been removed while the event was in flight.
    if (!this.watchers.has(folder.id)) return;
    const file = { path: p, size: st.size, mtime: Math.round(st.mtimeMs) };
    const autoTags = scanner.tagsFor(path.relative(folder.path, p), p);

    const moved = this.takeMatchingUnlink(file);
    if (moved && !db.hasPath(p)) {
      db.movePath(moved, p, folder.id, autoTags);
    } else {
      if (moved) db.removePath(moved); // moved over an existing file
      db.upsertFile(folder.id, file, autoTags);
    }
    this.onChange();
  }

  handleUnlink(p) {
    if (!scanner.isAudio(p)) return;
    const row = db.getByPath(p);
    if (!row) return;
    // Finder renames/moves arrive as unlink + add. Hold the delete briefly so a
    // matching add can move the row instead, preserving its manual tags.
    const timer = setTimeout(() => {
      this.pendingUnlinks.delete(p);
      db.removePath(p);
      this.onChange();
    }, RENAME_WINDOW_MS);
    this.pendingUnlinks.set(p, { row, timer });
  }

  handleUnlinkDir(dir) {
    // chokidar also emits 'unlink' for each file inside, which goes through
    // the rename window above; this just catches anything it missed.
    setTimeout(() => {
      const prefix = dir + path.sep;
      for (const p of this.pendingUnlinks.keys()) if (p.startsWith(prefix)) return;
      db.removeDir(dir);
      this.onChange();
    }, RENAME_WINDOW_MS + 500);
  }

  // Match on size + mtime (both survive a rename). Prefer the same filename,
  // since sample packs often have many equal-length files with one mtime.
  takeMatchingUnlink(file) {
    const candidates = [];
    for (const [p, { row }] of this.pendingUnlinks) {
      if (row.size_bytes === file.size && row.date_modified === file.mtime) candidates.push(p);
    }
    const base = path.basename(file.path);
    let match = candidates.find((p) => path.basename(p) === base);
    if (!match && candidates.length === 1) match = candidates[0];
    if (!match) return null;
    clearTimeout(this.pendingUnlinks.get(match).timer);
    this.pendingUnlinks.delete(match);
    return match;
  }
}

module.exports = { LibraryWatcher };
