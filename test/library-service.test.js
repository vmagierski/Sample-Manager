const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibrary } = require('../src/main/library-service');

// The library worker's logic, without the utility process around it.

function wav(seconds = 0.1, rate = 8000) {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lib-')));
const samples = path.join(dir, 'Samples');
fs.mkdirSync(path.join(samples, 'Drums'), { recursive: true });
fs.writeFileSync(path.join(samples, 'Drums', 'Kick 1.wav'), wav());
fs.writeFileSync(path.join(samples, 'Drums', 'Snare 1.wav'), wav());
fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify([{ tag: 'kick', pattern: 'kick' }, { tag: 'snare', pattern: 'snare' }]));

const events = [];
const toMain = [];
const lib = createLibrary({
  broadcast: (ch, ...args) => events.push([ch, ...args]),
  toMain: (ch, ...args) => toMain.push([ch, ...args]),
});
const ctx = (owner) => ({ owner });
const until = async (fn, ms = 3000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test.after(async () => {
  await lib.main.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('page calls wait for init', async () => {
  let done = false;
  const pending = lib.windows.listFolders(ctx(1)).then((v) => ((done = true), v));
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(done, false);
  lib.main.init({ dbFile: path.join(dir, 'library.db'), rulesPath: path.join(dir, 'rules.json') });
  assert.deepStrictEqual(await pending, []);
});

test('add a folder: scanned, tagged, and the pages are told', async () => {
  const res = await lib.main.addFolderPath(samples);
  assert.strictEqual(res.folder.path, samples);
  const list = await lib.windows.listSamples({}, ctx(1));
  assert.deepStrictEqual(list.rows.map((r) => [r.filename, r.tags]), [['Kick 1.wav', ['kick']], ['Snare 1.wav', ['snare']]]);
  assert.ok(await until(() => events.some(([ch, c]) => ch === 'library:changed' && c.all)));
  assert.ok(events.some(([ch, s]) => ch === 'scan:status' && s.busy === false));
  // Adding it again (or a folder inside it) just rescans it.
  assert.deepStrictEqual(await lib.main.addFolderPath(path.join(samples, 'Drums')), { existing: path.join(samples, 'Drums') });
  assert.strictEqual(await lib.main.isRuleTag('Kick'), true);
  assert.strictEqual(await lib.main.isRuleTag('pad'), false);
});

test('tag edits broadcast tags:changed', async () => {
  const [kick] = (await lib.windows.listSamples({ search: 'kick' }, ctx(1))).rows;
  events.length = 0;
  assert.deepStrictEqual(await lib.windows.updateTags(kick.id, ['kick', 'mine'], ctx(1)), ['kick', 'mine']);
  assert.deepStrictEqual(events, [['tags:changed']]);
});

test('readSample: bytes; newest wins per window, not across windows', async () => {
  const rows = (await lib.windows.listSamples({}, ctx(1))).rows;
  const bytes = await lib.windows.readSample(rows[0].id, ctx(1));
  assert.strictEqual(bytes.length, wav().length);
  // Window 1 asks for two samples at once: the first is dropped. Window 2's
  // read of the same sample isn't affected.
  const [a, b, c] = await Promise.all([
    lib.windows.readSample(rows[0].id, ctx(1)),
    lib.windows.readSample(rows[1].id, ctx(1)),
    lib.windows.readSample(rows[0].id, ctx(2)),
  ]);
  assert.strictEqual(a, null);
  assert.ok(b && b.length);
  assert.ok(c && c.length);
  await assert.rejects(lib.windows.readSample(999999, ctx(1)), /unknown sample/);
});

test('indexNow, renderCrop, hide / unhide', async () => {
  const file = path.join(samples, 'Kick 2.wav');
  fs.writeFileSync(file, wav(1));
  const id = await lib.main.indexNow(file);
  assert.ok(id);
  assert.strictEqual(await lib.main.indexNow(path.join(dir, 'rules.json')), null); // outside the library

  const tmp = await lib.main.renderCrop(file, 0.25, 0.75);
  assert.strictEqual(fs.statSync(tmp).size, 44 + 0.5 * 8000 * 2);
  fs.unlinkSync(tmp);

  await lib.main.hideDir(path.join(samples, 'Drums'));
  assert.strictEqual((await lib.windows.listSamples({}, ctx(1))).rows.length, 1);
  assert.deepStrictEqual(await lib.windows.listHidden(ctx(1)), [path.join(samples, 'Drums')]);
  await lib.main.unhideDir(path.join(samples, 'Drums'));
  assert.strictEqual((await lib.windows.listSamples({}, ctx(1))).rows.length, 3);
});

test('unreadable folders: privacy errors go to main for a dialog', async () => {
  const locked = path.join(dir, 'Locked');
  fs.mkdirSync(locked);
  await lib.main.addFolderPath(locked);
  fs.chmodSync(locked, 0o000);
  try {
    await lib.main.rescanAll();
    assert.deepStrictEqual(toMain.filter(([ch]) => ch === 'unreadable').map(([, f]) => f.label), ['Locked']);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('remove a folder', async () => {
  const folders = await lib.windows.listFolders(ctx(1));
  const f = folders.find((x) => x.label === 'Samples');
  assert.strictEqual(await lib.main.removeFolder(f.id), true);
  assert.strictEqual((await lib.windows.listSamples({}, ctx(1))).rows.length, 0);
  assert.strictEqual(await lib.main.removeFolder(f.id), false);
});
