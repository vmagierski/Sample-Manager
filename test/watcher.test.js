const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../src/main/db');
const { LibraryWatcher } = require('../src/main/watcher');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a library from before rules_hash is upgraded in place', () => {
  const file = path.join(dir, 'old.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, label TEXT);
            INSERT INTO folders (path, label) VALUES ('/old', 'old');`);
  old.close();
  db.open(file);
  const f = db.listFolders()[0];
  db.syncFolder(f.id, [{ path: '/old/a.wav', size: 1, mtime: 1 }], () => [], { rulesHash: 'h' });
  db.takeChanges();
  db.syncFolder(f.id, [{ path: '/old/a.wav', size: 1, mtime: 1 }], () => ['x'], { rulesHash: 'h' });
  assert.strictEqual(db.takeChanges(), null); // hash stored: nothing re-tagged
  db.close();
  const check = new Database(file);
  assert.strictEqual(check.pragma('user_version', { simple: true }), 2);
  check.close();
});

test('moving a folder of files keeps their rows (and tags), in one batch', async () => {
  db.open(path.join(dir, 'lib.db'));
  const folder = db.addFolder('/w', 'w');
  const files = ['a.wav', 'b.wav', 'c.wav'].map((n, i) => ({ path: `/w/old/${n}`, size: 10, mtime: 5 + (i === 2 ? 1 : 0) }));
  db.syncFolder(folder.id, files, () => []);
  const ids = files.map((f) => db.getByPath(f.path).id);
  db.setTags(ids[0], ['keep']);
  db.takeChanges();

  let notified = 0;
  const w = new LibraryWatcher({ onChange: () => notified++ });
  w.watchers.set(folder.id, { close: async () => {} }); // stand-in for chokidar
  for (const f of files) w.handleUnlink(f.path);
  // a.wav and b.wav have equal size + mtime: matched by name.
  for (const f of files) w.handleAdd(folder, f.path.replace('/old/', '/new/'), { size: f.size, mtimeMs: f.mtime, isFile: () => true });
  assert.strictEqual(w.pendingUnlinks.size, 0);
  assert.strictEqual(w.unlinksByStat.size, 0);
  w.flush();
  assert.strictEqual(notified, 1);
  assert.deepStrictEqual(files.map((f) => db.getByPath(f.path.replace('/old/', '/new/'))?.id), ids);
  assert.deepStrictEqual(db.listSamples({ search: 'a.wav' }).rows[0].tags, ['keep']);
  const c = db.takeChanges();
  assert.deepStrictEqual(c.dirs.map((d) => [d.dir, d.delta]), [['/w/old', -3], ['/w/new', 3]]);
  await w.closeAll();
});
