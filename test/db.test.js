const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/main/db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
db.open(path.join(dir, 'lib.db'));
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const root = '/lib';
const f = (name, size = 100) => ({ path: `${root}/${name}`, size, mtime: 1 });
const byName = (res) => Object.fromEntries(res.rows.map((r) => [r.filename, r.tags]));
const tagger = (p) => (/kick/i.test(p) ? ['kick'] : /snare/i.test(p) ? ['snare'] : []);

test('sync, filter, manual tags survive rescan', () => {
  const folder = db.addFolder(root, 'lib');
  db.syncFolder(folder.id, [f('Kick 1.wav'), f('Snare 1.wav'), f('Weird.wav')], tagger);
  let res = db.listSamples();
  assert.strictEqual(res.total, 3);
  assert.deepStrictEqual(byName(res), { 'Kick 1.wav': ['kick'], 'Snare 1.wav': ['snare'], 'Weird.wav': [] });

  // AND filter + untagged
  assert.deepStrictEqual(db.listSamples({ tags: ['kick'] }).rows.map((r) => r.filename), ['Kick 1.wav']);
  assert.strictEqual(db.listSamples({ tags: ['kick', 'snare'] }).rows.length, 0);
  assert.deepStrictEqual(db.listSamples({ untagged: true }).rows.map((r) => r.filename), ['Weird.wav']);

  // search matches filename and tag names, all terms ANDed
  assert.deepStrictEqual(db.listSamples({ search: 'snare' }).rows.map((r) => r.filename), ['Snare 1.wav']);
  assert.deepStrictEqual(db.listSamples({ search: 'kick 1' }).rows.map((r) => r.filename), ['Kick 1.wav']);
  assert.strictEqual(db.listSamples({ search: '100%' }).rows.length, 0);

  const kick = res.rows.find((r) => r.filename === 'Kick 1.wav');
  const weird = res.rows.find((r) => r.filename === 'Weird.wav');
  assert.deepStrictEqual(db.setTags(weird.id, ['Riser', ' dark ', 'riser']), ['dark', 'riser']);
  assert.deepStrictEqual(db.listSamples({ tags: ['dark', 'riser'] }).rows.map((r) => r.filename), ['Weird.wav']);
  assert.deepStrictEqual(db.listSamples({ tags: ['dark', 'riser', 'riser'] }).rows.map((r) => r.filename), ['Weird.wav']); // dupes ignored
  assert.strictEqual(db.listSamples({ tags: ['dark', 'kick'] }).rows.length, 0);
  assert.deepStrictEqual(db.setTags(kick.id, []), []); // remove an auto tag by hand

  // Rescan with Snare deleted: manual tags kept, removed auto tag stays removed.
  db.syncFolder(folder.id, [f('Kick 1.wav'), f('Weird.wav')], tagger);
  res = db.listSamples();
  assert.deepStrictEqual(byName(res), { 'Kick 1.wav': [], 'Weird.wav': ['dark', 'riser'] });
  // Tags no sample uses any more stay (count 0) until deleted on purpose.
  assert.deepStrictEqual(db.listTags().tags.map((t) => [t.name, t.count]), [['dark', 1], ['kick', 0], ['riser', 1], ['snare', 0]]);
  db.ensureTags(['Recorded']);
  assert.ok(db.listTags().tags.some((t) => t.name === 'recorded' && t.count === 0));
  assert.ok(db.deleteTag('dark'));
  assert.deepStrictEqual(db.listSamples({ search: 'weird' }).rows[0].tags, ['riser']);
  assert.ok(!db.listTags().tags.some((t) => t.name === 'dark'));
  db.setTags(weird.id, ['dark', 'riser']); // put it back for the tests below
});

test('watcher-style move keeps tags; removeDir; folder removal', () => {
  const folder = db.listFolders()[0];
  db.movePath('/lib/Weird.wav', '/lib/Sub/Renamed.wav', folder.id, []);
  const moved = db.getByPath('/lib/Sub/Renamed.wav');
  assert.ok(moved);
  assert.deepStrictEqual(db.listSamples({ search: 'renamed' }).rows[0].tags, ['dark', 'riser']);
  assert.strictEqual(db.listSamples({ search: 'sub' }).rows.length, 1); // folder path searchable

  db.removeDir('/lib/Sub');
  assert.strictEqual(db.getByPath('/lib/Sub/Renamed.wav'), undefined);

  db.removeFolder(folder.id);
  assert.strictEqual(db.listSamples().total, 0);
  assert.strictEqual(db.listFolders().length, 0);
});

test('parent folder absorbs child and keeps its tags', () => {
  const child = db.addFolder('/p/child', 'child');
  db.syncFolder(child.id, [{ path: '/p/child/a.wav', size: 1, mtime: 1 }], () => []);
  const a = db.getByPath('/p/child/a.wav');
  db.setTags(a.id, ['keep']);
  const parent = db.addFolder('/p', 'p');
  db.syncFolder(parent.id, [{ path: '/p/child/a.wav', size: 1, mtime: 1 }], () => []);
  db.removeFolder(child.id);
  const row = db.listSamples().rows[0];
  assert.strictEqual(row.folderId, parent.id);
  assert.deepStrictEqual(row.tags, ['keep']);
  assert.strictEqual(row.relPath, 'child/a.wav');
});

test('hidden folders drop out of lists, totals and tag counts, except when browsed', () => {
  const f = db.addFolder('/h', 'h');
  db.syncFolder(f.id, [
    { path: '/h/keep/Kick.wav', size: 1, mtime: 1 },
    { path: '/h/junk/Kick 2.wav', size: 1, mtime: 1 },
    { path: '/h/junk/deep/Kick 3.wav', size: 1, mtime: 1 },
    { path: '/h/junker/Kick 4.wav', size: 1, mtime: 1 }, // shares a prefix, must stay visible
  ], (p) => (/kick/i.test(p) ? ['kick'] : []));
  const names = (flt) => db.listSamples(flt).rows.map((r) => r.filename).filter((n) => n.startsWith('Kick')).sort();
  const before = db.listSamples().total;

  db.hideDir('/h/junk');
  assert.deepStrictEqual(names({}), ['Kick 4.wav', 'Kick.wav']);
  assert.strictEqual(db.listSamples().total, before - 2);
  assert.strictEqual(db.listTags().tags.find((t) => t.name === 'kick').count, 2);
  assert.deepStrictEqual(names({ search: 'kick' }), ['Kick 4.wav', 'Kick.wav']);
  // Browsing the hidden folder (or inside it) shows its contents.
  assert.deepStrictEqual(names({ dir: '/h/junk' }), ['Kick 2.wav', 'Kick 3.wav']);
  assert.deepStrictEqual(names({ dir: '/h/junk/deep' }), ['Kick 3.wav']);

  db.unhideDir('/h/junk');
  assert.strictEqual(db.listSamples().total, before);
  db.hideDir('/h/junk');
  db.removeFolder(f.id);
  assert.deepStrictEqual(db.listHidden(), []); // removing a folder forgets its hidden subfolders
});

test('multiple folders are ORed, and search stays inside them', () => {
  const f = db.addFolder('/m', 'm');
  db.syncFolder(f.id, ['a/Kick.wav', 'b/Kick.wav', 'c/Kick.wav', 'a/Snare.wav'].map((p) => ({ path: `/m/${p}`, size: 1, mtime: 1 })), () => []);
  const got = (flt) => db.listSamples(flt).rows.map((r) => r.relPath).sort();
  assert.deepStrictEqual(got({ dirs: ['/m/a', '/m/b'] }), ['a/Kick.wav', 'a/Snare.wav', 'b/Kick.wav']);
  assert.deepStrictEqual(got({ dirs: ['/m/a', '/m/b'], search: 'kick' }), ['a/Kick.wav', 'b/Kick.wav']);
  assert.deepStrictEqual(got({ dirs: ['/m', '/m/a'] }).length, 4); // overlapping selection
  db.hideDir('/m/b');
  assert.deepStrictEqual(got({ dirs: ['/m/a', '/m/b'] }), ['a/Kick.wav', 'a/Snare.wav', 'b/Kick.wav']); // selected hidden folder still shows
  assert.deepStrictEqual(got({ dirs: ['/m'] }), ['a/Kick.wav', 'a/Snare.wav', 'c/Kick.wav']);
  db.removeFolder(f.id);
});

test('rank + limit: file-name matches first, capped', () => {
  const f = db.addFolder('/r', 'r');
  db.syncFolder(f.id, ['Kick Loops/Groove.wav', 'Kick Loops/Big Kick.wav', 'Misc/Kick.wav', 'Misc/Kicker Long Name.wav'].map((p) => ({ path: `/r/${p}`, size: 1, mtime: 1 })), () => []);
  const got = db.listSamples({ dirs: ['/r'], search: 'kick', rank: true }).rows.map((r) => r.filename);
  assert.deepStrictEqual(got, ['Kick.wav', 'Big Kick.wav', 'Kicker Long Name.wav', 'Groove.wav']); // name hits (shortest first), then folder-only
  assert.strictEqual(db.listSamples({ dirs: ['/r'], search: 'kick', rank: true, limit: 2 }).rows.length, 2);
  assert.strictEqual(db.listSamples({ dirs: ['/r'], limit: 3 }).rows.length, 3);
  db.removeFolder(f.id);
});
