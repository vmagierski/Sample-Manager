const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const convcache = require('./convcache');

// Chromium's decoder (used by the renderer's Web Audio player) can't read
// AIFF, which is common in Logic libraries. Rewrap AIFF/AIFC PCM as WAV.

function readExtended(buf, off) {
  // 80-bit IEEE 754 extended precision (AIFF sample rate).
  const sign = buf[off] & 0x80 ? -1 : 1;
  const exp = ((buf[off] & 0x7f) << 8) | buf[off + 1];
  const hi = buf.readUInt32BE(off + 2);
  const lo = buf.readUInt32BE(off + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

function aiffToWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'FORM') throw new Error('not an AIFF file');
  const kind = buf.toString('ascii', 8, 12);
  if (kind !== 'AIFF' && kind !== 'AIFC') throw new Error('not an AIFF file');

  let comm = null;
  let ssnd = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const body = off + 8;
    if (id === 'COMM') {
      comm = {
        channels: buf.readUInt16BE(body),
        frames: buf.readUInt32BE(body + 2),
        bits: buf.readUInt16BE(body + 6),
        rate: readExtended(buf, body + 8),
        compression: kind === 'AIFC' ? buf.toString('ascii', body + 18, body + 22) : 'NONE',
      };
    } else if (id === 'SSND') {
      const dataOffset = buf.readUInt32BE(body);
      const start = body + 8 + dataOffset;
      ssnd = buf.subarray(start, Math.min(body + size, buf.length));
    }
    off = body + size + (size & 1);
  }
  if (!comm || !ssnd) throw new Error('AIFF missing COMM or SSND chunk');

  const { channels, frames, rate, compression } = comm;
  let { bits } = comm;
  let format = 1; // PCM
  let swap = true; // big-endian → little-endian
  let signed8 = true;

  switch (compression) {
    case 'NONE':
    case 'twos':
      break;
    case 'sowt':
      swap = false;
      break;
    case 'fl32':
    case 'FL32':
      format = 3;
      bits = 32;
      break;
    case 'fl64':
    case 'FL64':
      format = 3;
      bits = 64;
      break;
    case 'raw ':
      signed8 = false; // unsigned 8-bit, same as WAV
      break;
    default:
      throw new Error(`unsupported AIFC compression "${compression}"`);
  }

  const bytesPer = Math.ceil(bits / 8);
  const dataLen = Math.min(frames * channels * bytesPer, ssnd.length - (ssnd.length % (bytesPer * channels)));

  // One allocation for header + data, owning its whole ArrayBuffer (not a
  // slice of Node's pool), so the page can decode it without another copy.
  const out = Buffer.allocUnsafeSlow(44 + dataLen);
  const data = out.subarray(44);
  ssnd.copy(data, 0, 0, dataLen);

  if (bytesPer === 1) {
    if (signed8) for (let i = 0; i < data.length; i++) data[i] ^= 0x80;
  } else if (swap) {
    // Native swaps for the common sizes; 24-bit only has to trade its outer bytes.
    if (bytesPer === 2) data.swap16();
    else if (bytesPer === 4) data.swap32();
    else if (bytesPer === 8) data.swap64();
    else if (bytesPer === 3) {
      for (let i = 0; i + 3 <= data.length; i += 3) {
        const t = data[i];
        data[i] = data[i + 2];
        data[i + 2] = t;
      }
    } else {
      for (let i = 0; i + bytesPer <= data.length; i += bytesPer) {
        for (let a = i, b = i + bytesPer - 1; a < b; a++, b--) {
          const t = data[a];
          data[a] = data[b];
          data[b] = t;
        }
      }
    }
  }
  // AIFF allows odd bit depths (e.g. 20/24 left-justified in 3 bytes); WAV
  // stores them the same way, so declaring the container size is correct.
  const containerBits = bytesPer * 8;

  const header = out.subarray(0, 44);
  header.fill(0);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(Math.round(rate), 24);
  header.writeUInt32LE(Math.round(rate) * channels * bytesPer, 28);
  header.writeUInt16LE(channels * bytesPer, 32);
  header.writeUInt16LE(containerBits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return out;
}

// CAF (Apple Loops: usually AAC, sometimes ALAC/PCM) isn't a container
// Chromium can open. macOS's afconvert handles every CAF codec, ~35ms/loop.
// Converted once to 24-bit PCM — the format crops are cut in, so what you
// hear is what you drag — and kept in the conversion cache (convcache.js).
let tmpSeq = 0;
async function cafToWav(filePath, signal) {
  const st = await fs.promises.stat(filePath);
  const key = convcache.keyFor(filePath, st);
  const hit = convcache.lookup(key);
  if (hit) return fs.promises.readFile(hit, { signal });
  const out = convcache.enabled() ? convcache.tempFor(key) : path.join(os.tmpdir(), `sm-caf-${process.pid}-${++tmpSeq}.wav`);
  try {
    await afconvert(['-f', 'WAVE', '-d', 'LEI24', filePath, out], signal);
    if (convcache.enabled()) return await fs.promises.readFile(convcache.commit(key, out), { signal });
    return await fs.promises.readFile(out, { signal });
  } finally {
    fs.promises.unlink(out).catch(() => {}); // committed: already renamed away
  }
}

// Bytes the renderer can hand straight to decodeAudioData. `signal` aborts
// the read or conversion when the page has moved on to another sample.
async function readPlayable(filePath, signal) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'caf') return cafToWav(filePath, signal);
  const buf = await fs.promises.readFile(filePath, { signal });
  if (ext === 'aif' || ext === 'aiff' || ext === 'aifc') return aiffToWav(buf);
  return buf;
}

// --- cropping ---------------------------------------------------------------------

// Locate the fmt and data chunks of a RIFF/WAVE file.
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = buf.subarray(body, body + size);
    else if (id === 'data') {
      data = { start: body, len: Math.min(size, buf.length - body) };
      if (fmt) break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt or data chunk');
  return {
    fmt, // copied verbatim, so WAVE_FORMAT_EXTENSIBLE etc. survive
    channels: fmt.readUInt16LE(2),
    rate: fmt.readUInt32LE(4),
    blockAlign: fmt.readUInt16LE(12),
    dataStart: data.start,
    frames: Math.floor(data.len / fmt.readUInt16LE(12)),
  };
}

function chunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return body.length & 1 ? [head, body, Buffer.alloc(1)] : [head, body];
}

// Cut [startSec, endSec) out of a WAV, keeping its exact format (no re-encode).
function sliceWav(buf, startSec, endSec) {
  const w = parseWav(buf);
  const f0 = Math.max(0, Math.min(w.frames, Math.floor(startSec * w.rate)));
  const f1 = Math.max(f0, Math.min(w.frames, Math.ceil(endSec * w.rate)));
  const data = buf.subarray(w.dataStart + f0 * w.blockAlign, w.dataStart + f1 * w.blockAlign);
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunk('fmt ', w.fmt), ...chunk('data', data)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function afconvert(args, signal) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/afconvert', args, { signal }, (err, _o, stderr) =>
      err ? reject(err.name === 'AbortError' ? err : new Error(`afconvert failed: ${stderr || err.message}`)) : resolve());
  });
}

// Any supported sample as WAV at its original sample rate: WAV as-is, AIFF
// rewrapped losslessly, everything else (CAF, MP3, M4A, FLAC) decoded by
// macOS to 24-bit PCM.
async function toWav(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'wav' || ext === 'wave') return fs.promises.readFile(filePath);
  if (ext === 'aif' || ext === 'aiff' || ext === 'aifc') return aiffToWav(await fs.promises.readFile(filePath));
  if (ext === 'caf') return cafToWav(filePath);
  const out = path.join(os.tmpdir(), `sm-crop-${process.pid}-${++tmpSeq}.wav`);
  try {
    await afconvert(['-f', 'WAVE', '-d', 'LEI24', filePath, out]);
    return await fs.promises.readFile(out);
  } finally {
    fs.promises.unlink(out).catch(() => {});
  }
}

async function cropToWav(filePath, startSec, endSec) {
  return sliceWav(await toWav(filePath), startSec, endSec);
}

module.exports = { readPlayable, aiffToWav, readExtended, parseWav, sliceWav, cropToWav };
