const test = require('node:test');
const assert = require('node:assert');
const { aiffToWav } = require('../src/main/audio');

function ext80(rate) {
  // Encode a positive integer as 80-bit extended.
  const b = Buffer.alloc(10);
  const e = Math.floor(Math.log2(rate));
  b.writeUInt16BE(16383 + e, 0);
  const mant = BigInt(rate) << BigInt(63 - e);
  b.writeBigUInt64BE(mant, 2);
  return b;
}

function aiff({ kind = 'AIFF', compression, channels, bits, rate, samples }) {
  const bytes = bits / 8;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((v, i) => (bytes === 2 ? data.writeInt16BE(v, i * 2) : data.writeIntBE(v, i * bytes, bytes)));
  const comm = Buffer.alloc(kind === 'AIFC' ? 24 : 18);
  comm.writeUInt16BE(channels, 0);
  comm.writeUInt32BE(samples.length / channels, 2);
  comm.writeUInt16BE(bits, 6);
  ext80(rate).copy(comm, 8);
  if (kind === 'AIFC') comm.write(compression, 18, 'ascii');
  const chunk = (id, body) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const ssnd = chunk('SSND', Buffer.concat([Buffer.alloc(8), data]));
  const form = Buffer.concat([Buffer.from(kind), chunk('COMM', comm), ssnd]);
  const head = Buffer.alloc(8);
  head.write('FORM', 0, 'ascii');
  head.writeUInt32BE(form.length, 4);
  return Buffer.concat([head, form]);
}

test('16-bit stereo AIFF → WAV', () => {
  const wav = aiffToWav(aiff({ channels: 2, bits: 16, rate: 44100, samples: [1, -2, 300, -32768] }));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt16LE(20), 1);
  assert.strictEqual(wav.readUInt16LE(22), 2);
  assert.strictEqual(wav.readUInt32LE(24), 44100);
  assert.strictEqual(wav.readUInt16LE(34), 16);
  assert.strictEqual(wav.readUInt32LE(40), 8);
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2)), [1, -2, 300, -32768]);
});

test('24-bit mono AIFF at 48k', () => {
  const wav = aiffToWav(aiff({ channels: 1, bits: 24, rate: 48000, samples: [8388607, -1, 1234] }));
  assert.strictEqual(wav.readUInt32LE(24), 48000);
  assert.strictEqual(wav.readUInt16LE(34), 24);
  assert.deepStrictEqual([0, 1, 2].map((i) => wav.readIntLE(44 + i * 3, 3)), [8388607, -1, 1234]);
});

test('32-bit and long 16-bit AIFF swap correctly (native swap paths)', () => {
  const s32 = Array.from({ length: 300 }, (_, i) => (i * 7919 - 1e6) | 0);
  const w32 = aiffToWav(aiff({ channels: 2, bits: 32, rate: 44100, samples: s32 }));
  assert.deepStrictEqual(s32.map((_, i) => w32.readInt32LE(44 + i * 4)), s32);
  const s16 = Array.from({ length: 1000 }, (_, i) => ((i * 97) % 65536) - 32768);
  const w16 = aiffToWav(aiff({ channels: 1, bits: 16, rate: 44100, samples: s16 }));
  assert.deepStrictEqual(s16.map((_, i) => w16.readInt16LE(44 + i * 2)), s16);
});

test('the WAV owns its whole ArrayBuffer (no copy needed to decode it)', () => {
  const wav = aiffToWav(aiff({ channels: 1, bits: 16, rate: 44100, samples: [1, 2, 3] }));
  assert.strictEqual(wav.byteOffset, 0);
  assert.strictEqual(wav.buffer.byteLength, wav.length);
});

test('AIFC sowt is already little-endian', () => {
  const src = aiff({ kind: 'AIFC', compression: 'sowt', channels: 1, bits: 16, rate: 44100, samples: [0x0102] });
  const wav = aiffToWav(src);
  // Builder wrote big-endian bytes 01 02; sowt means they're passed through untouched.
  assert.deepStrictEqual([...wav.subarray(44, 46)], [0x01, 0x02]);
});

const { sliceWav, parseWav } = require('../src/main/audio');

function wav16(rate, channels, samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('sliceWav cuts whole frames and keeps the format', () => {
  // 10 stereo frames at 10 Hz = 1s; frame i has L = i, R = -i
  const src = wav16(10, 2, Array.from({ length: 10 }, (_, i) => [i, -i]).flat());
  const out = sliceWav(src, 0.2, 0.5);
  const w = parseWav(out);
  assert.strictEqual(w.rate, 10);
  assert.strictEqual(w.channels, 2);
  assert.strictEqual(w.frames, 3);
  assert.deepStrictEqual([0, 1, 2].map((f) => [out.readInt16LE(w.dataStart + f * 4), out.readInt16LE(w.dataStart + f * 4 + 2)]), [[2, -2], [3, -3], [4, -4]]);
  assert.strictEqual(out.readUInt32LE(4), out.length - 8); // RIFF size
  // Out-of-range times clamp instead of throwing.
  assert.strictEqual(parseWav(sliceWav(src, -1, 99)).frames, 10);
  assert.strictEqual(parseWav(sliceWav(src, 0.9, 0.1)).frames, 0);
});

test('sliceWav keeps extra chunks out and odd-sized fmt padded', () => {
  const src = wav16(8, 1, [1, 2, 3, 4, 5, 6, 7, 8]);
  // insert a LIST chunk before data
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.alloc(1)]);
  const withList = Buffer.concat([src.subarray(0, 36), list, src.subarray(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);
  const out = sliceWav(withList, 0.25, 0.75);
  const w = parseWav(out);
  assert.strictEqual(w.frames, 4);
  assert.deepStrictEqual([0, 1, 2, 3].map((f) => out.readInt16LE(w.dataStart + f * 2)), [3, 4, 5, 6]);
});
