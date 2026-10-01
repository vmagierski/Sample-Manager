const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const kits = require('../src/main/kits');
const { createLibrary } = require('../src/main/library-service');

test('safeName: one path component, nothing hidden or odd', () => {
  assert.strictEqual(kits.safeName('Trap Drums'), 'Trap Drums');
  assert.strictEqual(kits.safeName('  a/b:c  '), 'a-b-c');
  assert.strictEqual(kits.safeName('.hidden'), 'hidden');
  assert.strictEqual(kits.safeName('..'), '');
  assert.strictEqual(kits.safeName('name. '), 'name');
  assert.strictEqual(kits.safeName('x\u0000y\ttab'), 'x-y-tab');
  assert.strictEqual(kits.safeName(''), '');
  assert.strictEqual(kits.safeName(null), '');
  assert.strictEqual(kits.safeName('a'.repeat(300)).length, kits.NAME_MAX);
});

test('uniqueName: " 2", " 3" before the extension, case-insensitively', () => {
  const taken = new Set(['kick.wav']);
  assert.strictEqual(kits.uniqueName('Kick.wav', taken), 'Kick 2.wav');
  assert.strictEqual(kits.uniqueName('kick.WAV', taken), 'kick 3.WAV');
  assert.strictEqual(kits.uniqueName('Snare.wav', taken), 'Snare.wav');
  assert.strictEqual(kits.uniqueName('Snare.wav', taken), 'Snare 2.wav');
  assert.strictEqual(kits.uniqueName('noext', new Set(['noext'])), 'noext 2');
});

test('cropFileName', () => {
  assert.strictEqual(kits.cropFileName('/a/Kick.aif', 0.25, 1), 'Kick [0.25-1.00s].wav');
});

test('defaultKitName: shared folder, else shared tag, else Kit N; never a taken one', () => {
  const rows = (...p) => p.map(([file, ...tags]) => ({ path: file, tags }));
  assert.strictEqual(kits.defaultKitName(rows(['/s/Snares/a.wav'], ['/s/Snares/b.wav'])), 'Snares');
  assert.strictEqual(kits.defaultKitName(rows(['/s/Snares/a.wav'], ['/s/Snares/b.wav']), ['snares', 'Snares 2']), 'Snares 3');
  assert.strictEqual(kits.defaultKitName(rows(['/s/a/x.wav', 'kick', 'dry'], ['/s/b/y.wav', 'dry', 'kick'])), 'Kick');
  assert.strictEqual(kits.defaultKitName(rows(['/s/a/x.wav', 'kick'], ['/s/b/y.wav', 'snare'])), 'Kit 1');
  assert.strictEqual(kits.defaultKitName(rows(['/s/a/x.wav'], ['/s/b/y.wav']), ['Kit 1', 'kit 2']), 'Kit 3');
  assert.strictEqual(kits.defaultKitName([]), 'Kit 1');
});

test('kitOf / isKitDir', () => {
  assert.strictEqual(kits.kitOf('/k', '/k/A/x.wav'), '/k/A');
  assert.strictEqual(kits.kitOf('/k', '/k/A'), '/k/A');
  assert.strictEqual(kits.kitOf('/k', '/k'), null);
  assert.strictEqual(kits.kitOf('/k', '/other/A/x.wav'), null);
  assert.strictEqual(kits.kitOf('/k', '/k/../x'), null);
  assert.strictEqual(kits.isKitDir('/k', '/k/A'), true);
  assert.strictEqual(kits.isKitDir('/k', '/k/A/B'), false);
});

// --- service level: copying into a kit, in a temp library ---------------------

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

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-kits-')));
const samples = path.join(dir, 'Samples');
const kitsDir = path.join(dir, 'Music', 'Kits'); // outside the library until the first kit
fs.mkdirSync(path.join(samples, 'A'), { recursive: true });
fs.mkdirSync(path.join(samples, 'B'), { recursive: true });
fs.writeFileSync(path.join(samples, 'A', 'Kick.wav'), wav(1));
fs.writeFileSync(path.join(samples, 'B', 'Kick.wav'), wav(0.5));
fs.writeFileSync(path.join(samples, 'A', 'Snare.wav'), wav(0.2));
fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify([{ tag: 'kick', pattern: 'kick' }, { tag: 'snare', pattern: 'snare' }]));

const events = [];
const lib = createLibrary({ broadcast: (ch, ...a) => events.push([ch, ...a]), toMain: () => {} });
const ctx = { owner: 1 };

test.after(async () => {
  await lib.main.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const byName = async () => {
  const { rows } = await lib.windows.listSamples({}, ctx);
  return Object.fromEntries(rows.map((r) => [r.path.slice(dir.length + 1), r]));
};

test('copy into a new kit: files, collisions, crops, indexed right away', async () => {
  lib.main.init({ dbFile: path.join(dir, 'library.db'), rulesPath: path.join(dir, 'rules.json'), kitsDir });
  await lib.main.addFolderPath(samples);
  const rows = (await lib.windows.listSamples({}, ctx)).rows;
  const id = (rel) => rows.find((r) => r.path.endsWith(rel)).id;
  assert.deepStrictEqual(await lib.windows.listKits(ctx), []);
  assert.strictEqual(await lib.windows.suggestKitName([id('A/Kick.wav'), id('A/Snare.wav')], ctx), 'A');
  assert.strictEqual(await lib.windows.suggestKitName([id('A/Kick.wav'), id('B/Kick.wav')], ctx), 'Kick');

  // Hand-edited tags go with the copy.
  await lib.windows.updateTags(id('A/Snare.wav'), ['snare', 'my favourite'], ctx);

  const res = await lib.main.copyToKit({
    kit: 'Trap Drums',
    create: true,
    items: [{ id: id('A/Kick.wav') }, { id: id('B/Kick.wav') }, { id: id('A/Snare.wav') }, { id: id('A/Kick.wav'), start: 0.25, end: 0.75 }, { id: 987654 }],
  });
  const kit = path.join(dir, 'Music', 'Kits', 'Trap Drums');
  assert.strictEqual(res.kit, 'Trap Drums');
  assert.strictEqual(res.dir, kit);
  assert.strictEqual(res.copied, 4);
  assert.deepStrictEqual(res.failed, [{ name: '#987654', error: 'not in the library' }]);
  assert.deepStrictEqual(fs.readdirSync(kit).sort(), ['Kick 2.wav', 'Kick [0.25-0.75s].wav', 'Kick.wav', 'Snare.wav']);
  assert.strictEqual(fs.statSync(path.join(kit, 'Kick.wav')).size, 44 + 8000 * 2); // A/Kick.wav, 1 s
  assert.strictEqual(fs.statSync(path.join(kit, 'Kick 2.wav')).size, 44 + 4000 * 2); // B/Kick.wav, 0.5 s
  assert.strictEqual(fs.statSync(path.join(kit, 'Kick [0.25-0.75s].wav')).size, 44 + 4000 * 2);

  // Indexed already (its folder was added to the library), with tags.
  const all = await byName();
  const rel = (f) => path.join('Music', 'Kits', 'Trap Drums', f);
  assert.ok(all[rel('Kick.wav')] && all[rel('Kick 2.wav')]);
  assert.deepStrictEqual(all[rel('Kick.wav')].tags, ['kick']);
  assert.deepStrictEqual(all[rel('Snare.wav')].tags, ['my favourite', 'snare']);
  assert.strictEqual(res.ids.length, 4);
  assert.deepStrictEqual(await lib.windows.listKits(ctx), ['Trap Drums']);
  await new Promise((r) => setTimeout(r, 300)); // changes are announced after a short wait
  assert.ok(events.some(([ch]) => ch === 'library:changed'));
});

test('add to an existing kit, never overwriting; bad names and missing kits are refused', async () => {
  const rows = (await lib.windows.listSamples({}, ctx)).rows;
  const snare = rows.find((r) => r.path.endsWith(path.join('A', 'Snare.wav')));
  const res = await lib.main.copyToKit({ kit: 'Trap Drums', items: [{ id: snare.id }] });
  assert.strictEqual(res.copied, 1);
  assert.ok(fs.existsSync(path.join(res.dir, 'Snare 2.wav')));
  await assert.rejects(lib.main.copyToKit({ kit: 'Trap Drums', create: true, items: [] }), /already exists/);
  await assert.rejects(lib.main.copyToKit({ kit: 'Nope', items: [] }), /no kit named/);
  await assert.rejects(lib.main.copyToKit({ kit: '../escape', create: true, items: [] }), /usable kit name/);
  await assert.rejects(lib.main.copyToKit({ kit: 'a/b', items: [] }), /usable kit name/);
});

test('a missing source is reported and the rest still copy', async () => {
  const rows = (await lib.windows.listSamples({}, ctx)).rows;
  const kick = rows.find((r) => r.path === path.join(samples, 'B', 'Kick.wav'));
  const snare = rows.find((r) => r.path === path.join(samples, 'A', 'Snare.wav'));
  fs.unlinkSync(kick.path);
  const res = await lib.main.copyToKit({ kit: 'Second', create: true, items: [{ id: kick.id }, { id: snare.id }] });
  assert.strictEqual(res.copied, 1);
  assert.deepStrictEqual(res.failed, [{ name: 'Kick.wav', error: 'file is missing' }]);
  assert.deepStrictEqual(fs.readdirSync(res.dir), ['Snare.wav']); // no half-written Kick.wav left
});

test('200 files copy in one go', async () => {
  const big = path.join(samples, 'Big');
  fs.mkdirSync(big);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(big, `s${i}.wav`), wav(0.05));
  await lib.main.addFolderPath(big); // already covered: rescans
  const deadline = Date.now() + 5000;
  let ids;
  do {
    await new Promise((r) => setTimeout(r, 50));
    ids = (await lib.windows.listSamples({}, ctx)).rows.filter((r) => r.path.startsWith(big)).map((r) => r.id);
  } while (ids.length < 200 && Date.now() < deadline);
  assert.strictEqual(ids.length, 200);
  const t0 = Date.now();
  const res = await lib.main.copyToKit({ kit: 'Big', create: true, items: ids.map((id) => ({ id })) });
  assert.strictEqual(res.copied, 200);
  assert.strictEqual(fs.readdirSync(res.dir).length, 200);
  assert.ok(Date.now() - t0 < 5000);
});

test('rename a kit: the folder moves; clashes and bad names are refused', async () => {
  const res = await lib.main.renameKit('Second', 'Third');
  assert.strictEqual(path.basename(res.dir), 'Third');
  assert.ok(fs.existsSync(path.join(res.dir, 'Snare.wav')));
  assert.ok(!fs.existsSync(path.join(path.dirname(res.dir), 'Second')));
  await assert.rejects(lib.main.renameKit('Third', 'Trap Drums'), /already exists/);
  await assert.rejects(lib.main.renameKit('Third', 'x/y'), /usable kit name/);
  await assert.rejects(lib.main.renameKit('../Music', 'Zed'), /Not a kit/);
  assert.deepStrictEqual(await lib.windows.listKits(ctx), ['Big', 'Third', 'Trap Drums']);
});
