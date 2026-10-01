const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const scanner = require('./scanner');
const { LibraryWatcher } = require('./watcher');
const { readPlayable, cropToWav } = require('./audio');
const convcache = require('./convcache');
const { latestWins } = require('./latest');
const kits = require('./kits');

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

// Files copied into a kit at once.
const KIT_COPIES = 6;

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

  // The library folder that holds `p` (a real path), if any.
  const covering = (p) => db.listFolders().find((f) => p === f.path || p.startsWith(f.path + path.sep));

  // Make sure `dir` is inside a watched library folder, adding it if you
  // removed the folder that held it, so kits never end up invisible.
  async function ensureWatched(dir) {
    if (covering(dir)) return;
    const folder = db.addFolder(dir, 'Kits');
    watcher.watch(folder);
    notifyChanged();
  }

  async function listKits() {
    let entries;
    try {
      entries = await fs.promises.readdir(config.kitsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  // --- requests from main -----------------------------------------------------

  const readLatest = latestWins();
  let cropSeq = 0;

  const main = {
    // config: { dbFile, rulesPath, cacheDir, cacheCap, appMusicDir, recordDir, appMusicMarker, kitsDir }
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

    // Copy samples into the kit folder `kit` under config.kitsDir (made when
    // `create`; otherwise it must exist), then index the copies right away so
    // the page can show them. items: [{ id, start?, end? }] — with a region the
    // copy is that part as a WAV. A sample that can't be copied is reported,
    // not fatal: { kit, dir, copied, failed: [{ name, error }], ids }.
    async copyToKit({ kit, create = false, items }) {
      const name = kits.safeName(kit);
      if (!name || name !== String(kit).trim()) throw new Error('That isn’t a usable kit name');
      await fs.promises.mkdir(config.kitsDir, { recursive: true });
      const root = await fs.promises.realpath(config.kitsDir);
      const dir = path.join(root, name);
      if (create) {
        try {
          await fs.promises.mkdir(dir);
        } catch (err) {
          if (err.code === 'EEXIST') throw new Error(`A kit named “${name}” already exists`);
          throw err;
        }
      } else if (!(await fs.promises.stat(dir).catch(() => null))?.isDirectory()) {
        throw new Error(`There is no kit named “${name}”`);
      }
      await ensureWatched(root);

      // Destination names are settled up front, in selection order, so the
      // result doesn't depend on which copy finishes first.
      const taken = new Set((await fs.promises.readdir(dir)).map((n) => n.toLowerCase()));
      const jobs = [];
      const failed = [];
      for (const item of items || []) {
        const row = db.getById(item.id);
        if (!row) {
          failed.push({ name: `#${item.id}`, error: 'not in the library' });
          continue;
        }
        const crop = item.end > item.start ? [item.start, item.end] : null;
        const file = kits.uniqueName(kits.safeName(crop ? kits.cropFileName(row.path, ...crop) : row.filename) || 'Sound', taken);
        jobs.push({ row, crop, dest: path.join(dir, file) });
      }

      const copyOne = async (job) => {
        try {
          if (job.crop) {
            try {
              await fs.promises.writeFile(job.dest, await cropToWav(job.row.path, ...job.crop), { flag: 'wx' });
            } catch (err) {
              if (err.code === 'EEXIST') throw err;
              // Not croppable (or unreadable as audio): the whole sample, like a drag.
              await fs.promises.rm(job.dest, { force: true });
              job.dest = path.join(path.dirname(job.dest), kits.uniqueName(kits.safeName(job.row.filename), taken));
              job.crop = null;
              await fs.promises.copyFile(job.row.path, job.dest, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
            }
          } else {
            await fs.promises.copyFile(job.row.path, job.dest, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          }
          job.done = true;
        } catch (err) {
          await fs.promises.rm(job.dest, { force: true }).catch(() => {});
          failed.push({ name: job.row.filename, error: err.code === 'ENOENT' ? 'file is missing' : err.message });
        }
      };
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(KIT_COPIES, jobs.length) }, async () => {
          while (next < jobs.length) await copyOne(jobs[next++]);
        })
      );

      // Index the copies now (the watcher would, ~1s later), carrying over tags
      // that were edited by hand — the rest derive from the new path as usual.
      const ids = [];
      const folder = covering(root);
      const copies = jobs.filter((j) => j.done);
      for (let i = 0; i < copies.length; i += 50) {
        db.batch(() => {
          for (const job of copies.slice(i, i + 50)) {
            const st = fs.statSync(job.dest);
            const id = db.upsertFile(folder.id, { path: job.dest, size: st.size, mtime: Math.round(st.mtimeMs) },
              scanner.tagsFor(path.relative(folder.path, job.dest), job.dest));
            if (job.row.tags_edited) db.setTags(id, db.getRows([job.row.id])[0]?.tags || []);
            ids.push(id);
          }
        });
        await new Promise(setImmediate);
      }
      notifyChanged();
      return { kit: name, dir, copied: copies.length, failed, ids };
    },

    // Kit names, alphabetical.
    listKits: () => listKits(),

    // Rename a kit's folder. The watcher sees the files move (keeping their
    // tags); nothing is rescanned here.
    async renameKit(from, to) {
      const name = kits.safeName(to);
      if (!name || name !== String(to).trim()) throw new Error('That isn’t a usable kit name');
      if (kits.safeName(from) !== from) throw new Error('Not a kit');
      const root = await fs.promises.realpath(config.kitsDir);
      const src = path.join(root, from);
      const dest = path.join(root, name);
      if (name === from) return { kit: name, dir: dest };
      // A case-only change is the same folder on a case-insensitive volume.
      if (name.toLowerCase() !== from.toLowerCase() && (await fs.promises.stat(dest).catch(() => null))) {
        throw new Error(`A kit named “${name}” already exists`);
      }
      await fs.promises.rename(src, dest);
      return { kit: name, dir: dest };
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
    listKits: whenReady(() => listKits()),
    // A name for a new kit made from these samples (see kits.defaultKitName).
    suggestKitName: whenReady(async (ids) => {
      const rows = db.getRows([].concat(ids || []).slice(0, ROWS_MAX));
      return kits.defaultKitName(rows, await listKits());
    }),
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
