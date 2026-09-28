const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const scanner = require('./scanner');
const { LibraryWatcher } = require('./watcher');
const { readPlayable, cropToWav } = require('./audio');
const convcache = require('./convcache');
const { latestWins } = require('./latest');

// Everything the library worker does: the database (its only writer),
// scanning, watching, and reading/converting audio. No Electron here — the
// worker entry (library-worker.js) wires it to its ports, and tests call it
// directly.
//
// createLibrary({ broadcast(ch, ...args), toMain(ch, ...args) }) returns
//   main:    handlers for main's requests (folders, menus, crops, shutdown)
//   windows: handlers for the pages' requests; the last argument is
//            { owner } — one per window connection, for newest-wins reads
//   closed(owner): a window's connection went away
// Rows per getRows call: a screenful and then some, not the library.
const ROWS_MAX = 2000;

function createLibrary({ broadcast, toMain }) {
  let config = null;
  let watcher = null;
  let markReady;
  const ready = new Promise((resolve) => (markReady = resolve));
  let stopped = false;

  // Tell the pages what changed in the library (see db.takeChanges) —
  // nothing if nothing did, e.g. a rescan that found every file as it was.
  let changeTimer = null;
  function notifyChanged() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (stopped) return;
      const changes = db.takeChanges();
      if (changes) broadcast('library:changed', changes);
    }, 150);
  }

  // --- scanning (serialized so two walks never race on the same rows) ------

  let scanQueue = Promise.resolve();
  let scansPending = 0;

  function enqueueScan(label, fn) {
    scansPending++;
    broadcast('scan:status', { busy: true, label });
    const run = scanQueue.then(fn).catch((err) => console.error(`${label} failed:`, err));
    scanQueue = run.finally(() => {
      scansPending--;
      broadcast('scan:status', scansPending ? { busy: true, label: 'Scanning…' } : { busy: false });
      notifyChanged();
    });
    return scanQueue;
  }

  // Folders we've already warned about (per worker run).
  const blockedWarned = new Set();

  function warnUnreadable(folder, err) {
    if (blockedWarned.has(folder.id)) return;
    blockedWarned.add(folder.id);
    if (err.code === 'EPERM' || err.code === 'EACCES') toMain('unreadable', { label: folder.label, path: folder.path });
    // e.g. an unplugged drive: keep its samples, just say so in the status line.
    else broadcast('scan:status', { busy: false, label: `${folder.label} is unavailable — kept its samples` });
  }

  function scanFolder(folder) {
    return enqueueScan(`Scanning ${folder.label}…`, async () => {
      if (stopped) return;
      const startedAt = Date.now();
      let files;
      try {
        files = await scanner.walk(folder.path);
      } catch (err) {
        console.warn(`scan: can't read ${folder.path}: ${err.message}`);
        warnUnreadable(folder, err);
        return; // leave its rows (and tags) untouched
      }
      if (stopped || !db.getFolder(folder.id)) return; // removed mid-scan
      // Only new and changed files are written (and everything re-tagged if
      // tag-rules.json changed), a chunk at a time between other work.
      await db.syncFolderAsync(folder.id, files, (p) => scanner.tagsFor(path.relative(folder.path, p), p), {
        rulesHash: scanner.rulesHash(),
        startedAt,
      });
    });
  }

  function loadRules() {
    try {
      scanner.loadRules(config.rulesPath);
      db.ensureTags(scanner.ruleTags()); // rule tags always show, even with no samples yet
    } catch (err) {
      toMain('rulesError', err.message);
    }
  }

  function rescanAll() {
    loadRules();
    return Promise.all(db.listFolders().map(scanFolder));
  }

  // Once per library: create the app's own music folder and add it. If you
  // later remove it from the library, it stays removed. (The marker lives with
  // the library, so a test library doesn't use up the real one's first run.)
  function ensureAppMusicDir() {
    const { appMusicDir, recordDir, appMusicMarker } = config;
    if (!appMusicDir || fs.existsSync(appMusicMarker)) return;
    try {
      fs.mkdirSync(recordDir, { recursive: true });
      const real = fs.realpathSync(appMusicDir);
      const covered = db.listFolders().some((f) => real === f.path || real.startsWith(f.path + path.sep));
      if (!covered) db.addFolder(real, 'Sample Manager');
      fs.writeFileSync(appMusicMarker, new Date().toISOString());
    } catch (err) {
      console.warn(`couldn't set up ${appMusicDir}:`, err.message);
    }
  }

  // --- requests from main -----------------------------------------------------

  const readLatest = latestWins();
  let cropSeq = 0;

  const main = {
    // config: { dbFile, rulesPath, cacheDir, cacheCap, appMusicDir, recordDir, appMusicMarker }
    init(cfg) {
      config = cfg;
      db.open(cfg.dbFile);
      loadRules();
      ensureAppMusicDir();
      if (cfg.cacheDir) {
        try {
          convcache.configure(cfg.cacheDir, cfg.cacheCap);
        } catch (err) {
          console.warn(`conversion cache off: ${err.message}`); // CAFs still play, just converted each time
        }
      }
      watcher = new LibraryWatcher({ onChange: notifyChanged });
      markReady();
      // Catch anything that changed while the app was closed, then keep watching.
      for (const folder of db.listFolders()) {
        watcher.watch(folder);
        scanFolder(folder);
      }
      return true;
    },

    rescanAll: () => rescanAll().then(() => true),

    // picked: a folder the user chose. { folder } once added and scanned,
    // { existing: realPath } if the library already covers it (rescanned),
    // or { error }.
    async addFolderPath(picked) {
      let real;
      try {
        real = fs.realpathSync(picked);
      } catch (err) {
        return { error: err.message };
      }
      const existing = db.listFolders();
      const covering = existing.find((f) => real === f.path || real.startsWith(f.path + path.sep));
      // Already in the library (itself, or inside a folder that is): not an
      // error — rescan it (that's usually why it was re-added) and show it.
      if (covering) {
        scanFolder(covering);
        return { existing: real };
      }

      const folder = db.addFolder(real, path.basename(real) || real);
      watcher.watch(folder);
      await scanFolder(folder);

      // Adding a parent of an existing folder absorbs it. The scan above already
      // re-pointed those samples at the parent (keeping their tags).
      for (const child of existing.filter((f) => f.path.startsWith(real + path.sep))) {
        await watcher.unwatch(child.id);
        db.removeFolder(child.id);
      }
      notifyChanged();
      return { folder };
    },

    async removeFolder(id) {
      if (!db.getFolder(id)) return false;
      await watcher.unwatch(id);
      db.removeFolder(id);
      notifyChanged();
      return true;
    },

    deleteTag(name) {
      const done = db.deleteTag(name);
      notifyChanged();
      return done;
    },

    isRuleTag: (name) => scanner.ruleTags().map(db.normalizeTag).includes(db.normalizeTag(name)),

    hideDir(dir) {
      db.hideDir(dir);
      notifyChanged();
      return true;
    },

    unhideDir(dir) {
      db.unhideDir(dir);
      notifyChanged();
      return true;
    },

    // Add a file we just wrote to the library right away (the watcher would
    // get there too, but ~1s later), so the page can select it. Null if it
    // was saved outside every library folder.
    indexNow(filePath) {
      let real;
      try {
        real = fs.realpathSync(filePath);
      } catch {
        return null;
      }
      const folder = db.listFolders().find((f) => real.startsWith(f.path + path.sep));
      if (!folder) return null;
      const st = fs.statSync(real);
      db.upsertFile(folder.id, { path: real, size: st.size, mtime: Math.round(st.mtimeMs) },
        scanner.tagsFor(path.relative(folder.path, real), real));
      notifyChanged();
      return db.getByPath(real).id;
    },

    // Cut [start, end) seconds of a sample into a temp WAV; its path.
    async renderCrop(filePath, start, end) {
      const buf = await cropToWav(filePath, start, end);
      const tmp = path.join(os.tmpdir(), `sm-crop-${process.pid}-${++cropSeq}.wav`);
      await fs.promises.writeFile(tmp, buf);
      return tmp;
    },

    // Quitting: stop watching and close the database. Nothing runs after.
    async shutdown() {
      stopped = true;
      clearTimeout(changeTimer);
      const closing = watcher ? watcher.closeAll().catch(() => {}) : null;
      db.close();
      await closing;
      return true;
    },
  };

  // --- requests from the pages --------------------------------------------------

  const whenReady = (fn) => async (...args) => {
    await ready;
    if (stopped) throw new Error('library closed');
    return fn(...args);
  };

  const windows = {
    listSamples: whenReady((filter) => db.listSamples(filter)),
    // The main list: a view's ids, then rows for what's on screen.
    listIds: whenReady((filter) => db.listIds(filter)),
    getRows: whenReady((ids) => db.getRows([].concat(ids || []).slice(0, ROWS_MAX))),
    listTags: whenReady(() => db.listTags()),
    listDirs: whenReady(() => db.listDirs()),
    listFolders: whenReady(() => db.listFolders()),
    listHidden: whenReady(() => db.listHidden()),
    updateTags: whenReady((id, tags) => {
      const out = db.setTags(id, Array.isArray(tags) ? tags : []);
      broadcast('tags:changed');
      return out;
    }),
    setDuration: whenReady((id, ms) => {
      db.setDuration(id, ms);
      return true;
    }),
    // Newest wins per window: arrowing past a sample aborts its read or
    // conversion, and resolves null instead of sending its bytes.
    readSample: whenReady((id, ctx) => {
      const row = db.getById(id);
      if (!row) throw new Error('unknown sample');
      return readLatest(ctx.owner, id, (signal) => readPlayable(row.path, signal));
    }),
  };

  return { main, windows };
}

module.exports = { createLibrary };
