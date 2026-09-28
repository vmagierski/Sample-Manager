const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BufferCache, ownBuffer, createLoader } = require('../src/renderer/buffer-cache');
const { latestWins } = require('../src/main/latest');
const convcache = require('../src/main/convcache');
const audio = require('../src/main/audio');

const MB = 1024 ** 2;
// A stand-in AudioBuffer: `mb` megabytes decoded (float32 mono).
const fakeBuf = (mb) => ({ length: (mb * MB) / 4, numberOfChannels: 1 });

// --- decoded-buffer cache ---------------------------------------------------------

test('cache: bounded by bytes, least recently used out first', () => {
  const c = new BufferCache(10 * MB);
  c.set(1, fakeBuf(4));
  c.set(2, fakeBuf(4));
  c.get(1); // 1 is now the most recent
  c.set(3, fakeBuf(4));
  assert.deepStrictEqual([...c.map.keys()], [1, 3]);
  assert.strictEqual(c.bytes, 8 * MB);
});

test('cache: a buffer bigger than the budget is not kept', () => {
  const c = new BufferCache(10 * MB);
  c.set(1, fakeBuf(4));
  assert.strictEqual(c.set(2, fakeBuf(11)), false);
  assert.deepStrictEqual([...c.map.keys()], [1]);
  assert.strictEqual(c.bytes, 4 * MB);
});

test('cache: the pinned (playing) buffer is never evicted', () => {
  const c = new BufferCache(10 * MB);
  c.set(1, fakeBuf(6));
  c.pin(1);
  c.set(2, fakeBuf(3));
  c.set(3, fakeBuf(3)); // over budget: 2 goes, not 1
  assert.deepStrictEqual([...c.map.keys()], [1, 3]);
});

test('cache: replacing an entry does not double-count it', () => {
  const c = new BufferCache(10 * MB);
  c.set(1, fakeBuf(4));
  c.set(1, fakeBuf(2));
  assert.strictEqual(c.bytes, 2 * MB);
});

test('ownBuffer: no copy for a whole buffer, a copy for a view into a larger one', () => {
  const whole = new Uint8Array(8);
  assert.strictEqual(ownBuffer(whole), whole.buffer);
  const view = new Uint8Array(new ArrayBuffer(16), 4, 8);
  const ab = ownBuffer(view);
  assert.notStrictEqual(ab, view.buffer);
  assert.strictEqual(ab.byteLength, 8);
});

// --- loader ------------------------------------------------------------------------

function harness() {
  const calls = { read: [], decode: 0 };
  const pending = new Map();
  const cache = new BufferCache(100 * MB);
  const read = (id) => {
    calls.read.push(id);
    return new Promise((resolve) => pending.set(id, resolve));
  };
  const decode = async () => {
    calls.decode++;
    return fakeBuf(1);
  };
  return { calls, pending, cache, load: createLoader(cache, read, decode) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('loader: stale before the read → nothing is requested', async () => {
  const h = harness();
  assert.strictEqual(await h.load(1, () => true), null);
  assert.deepStrictEqual(h.calls.read, []);
});

test('loader: moved on while reading → not decoded, not cached', async () => {
  const h = harness();
  let stale = false;
  const p = h.load(1, () => stale);
  await tick();
  stale = true;
  h.pending.get(1)(new Uint8Array(4));
  assert.strictEqual(await p, null);
  assert.strictEqual(h.calls.decode, 0);
  assert.strictEqual(h.cache.has(1), false);
});

test('loader: main dropped the read (null bytes) → null, nothing decoded', async () => {
  const h = harness();
  const p = h.load(1, () => false);
  await tick();
  h.pending.get(1)(null);
  assert.strictEqual(await p, null);
  assert.strictEqual(h.calls.decode, 0);
});

test('loader: a play joins a prefetch of the same sample and takes it over', async () => {
  const h = harness();
  let prefetchCancelled = false;
  const pre = h.load(1, () => prefetchCancelled);
  await tick();
  prefetchCancelled = true; // the play cancels prefetching…
  const play = h.load(1, () => false); // …but wants this very sample
  h.pending.get(1)(new Uint8Array(4));
  const buf = await play;
  assert.ok(buf);
  assert.strictEqual(await pre, buf);
  assert.deepStrictEqual(h.calls.read, [1]); // read once
  assert.strictEqual(h.cache.get(1), buf);
  assert.strictEqual(await h.load(1, () => false), buf); // then from the cache
});

// --- newest wins in main -------------------------------------------------------------

test('latestWins: a newer request aborts the one in flight, which resolves null', async () => {
  const run = latestWins();
  const signals = [];
  const slow = (v) => (signal) => {
    signals.push(signal);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(v), 20);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };
  const a = run('win', 1, slow('a'));
  const b = run('win', 2, slow('b'));
  assert.strictEqual(await a, null);
  assert.strictEqual(await b, 'b');
  assert.strictEqual(signals[0].aborted, true);
});

test('latestWins: the same sample again shares the load; other windows are independent', async () => {
  const run = latestWins();
  let loads = 0;
  const load = (v) => async () => {
    loads++;
    await tick();
    return v;
  };
  const a1 = run('win', 1, load('a'));
  const a2 = run('win', 1, load('a'));
  const q = run('quick', 2, load('q'));
  assert.deepStrictEqual(await Promise.all([a1, a2, q]), ['a', 'a', 'q']);
  assert.strictEqual(loads, 2);
});

test('latestWins: a real failure still rejects', async () => {
  const run = latestWins();
  await assert.rejects(run('win', 1, async () => {
    throw new Error('boom');
  }), /boom/);
});

// --- conversion cache on disk ------------------------------------------------------------

test('convcache: least recently used entries go when over the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-conv-'));
  convcache.configure(dir, 10 * 1024);
  const put = (key, bytes, age) => {
    const tmp = convcache.tempFor(key);
    fs.writeFileSync(tmp, Buffer.alloc(bytes));
    const file = convcache.commit(key, tmp);
    const t = new Date(Date.now() - age);
    fs.utimesSync(file, t, t);
  };
  put('old', 4096, 3000);
  put('mid', 4096, 2000);
  assert.ok(convcache.lookup('old')); // used just now: no longer the oldest
  put('new', 4096, 0); // 12 KB > 10 KB: prune to 90%
  assert.strictEqual(convcache.lookup('mid'), null);
  assert.ok(convcache.lookup('old'));
  assert.ok(convcache.lookup('new'));
  fs.rmSync(dir, { recursive: true });
});

test('convcache: keys change with size and mtime', () => {
  const k = (size, mtimeMs) => convcache.keyFor('/a.caf', { size, mtimeMs });
  assert.strictEqual(k(1, 2), k(1, 2));
  assert.notStrictEqual(k(1, 2), k(1, 3));
  assert.notStrictEqual(k(1, 2), k(2, 2));
});

// CAF needs macOS's afconvert.
const hasAfconvert = fs.existsSync('/usr/bin/afconvert');

function wav16(frames) {
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(44100, 24);
  h.writeUInt32LE(88200, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('CAF: converted once, then served from the cache', { skip: !hasAfconvert }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-caf-'));
  convcache.configure(path.join(dir, 'cache'), 100 * MB);
  const src = path.join(dir, 'in.wav');
  const caf = path.join(dir, 'loop.caf');
  fs.writeFileSync(src, wav16(44100));
  await new Promise((resolve, reject) =>
    require('child_process').execFile('/usr/bin/afconvert', ['-f', 'caff', '-d', 'aac', src, caf], (e) => (e ? reject(e) : resolve())));

  const first = await audio.readPlayable(caf);
  const w = audio.parseWav(first);
  assert.strictEqual(w.rate, 44100);
  assert.strictEqual(w.blockAlign, 4); // 32-bit float mono
  assert.strictEqual(fs.readdirSync(path.join(dir, 'cache')).length, 1);

  const again = await audio.readPlayable(caf);
  assert.ok(first.equals(again));
  fs.rmSync(dir, { recursive: true });
});

test('CAF: an aborted conversion leaves nothing behind', { skip: !hasAfconvert }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-caf-'));
  convcache.configure(path.join(dir, 'cache'), 100 * MB);
  const src = path.join(dir, 'in.wav');
  const caf = path.join(dir, 'long.caf');
  fs.writeFileSync(src, wav16(44100 * 120));
  await new Promise((resolve, reject) =>
    require('child_process').execFile('/usr/bin/afconvert', ['-f', 'caff', '-d', 'aac', src, caf], (e) => (e ? reject(e) : resolve())));
  const ctrl = new AbortController();
  const p = audio.readPlayable(caf, ctrl.signal);
  setTimeout(() => ctrl.abort(), 5);
  await assert.rejects(p, (err) => err.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 50)); // the temp file's unlink is async
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'cache')), []);
  fs.rmSync(dir, { recursive: true });
});
