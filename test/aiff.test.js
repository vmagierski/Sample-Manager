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

test('AIFC sowt is already little-endian', () => {
  const src = aiff({ kind: 'AIFC', compression: 'sowt', channels: 1, bits: 16, rate: 44100, samples: [0x0102] });
  const wav = aiffToWav(src);
  // Builder wrote big-endian bytes 01 02; sowt means they're passed through untouched.
  assert.deepStrictEqual([...wav.subarray(44, 46)], [0x01, 0x02]);
});
