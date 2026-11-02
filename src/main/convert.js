const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Decoding what Chromium and audio.js can't read themselves — CAF (Apple
// Loops), and MP3/M4A/FLAC/OGG when a crop has to be cut from them — to WAV.
//
// macOS: afconvert, which ships with the OS and handles every CAF codec.
// Elsewhere: ffmpeg, if one can be found (see ffmpegPath). Without either,
// toWav rejects with ConverterMissing: CAFs don't play, and the page cuts
// crops from the audio it decoded instead (see crop.provide).

const AFCONVERT = '/usr/bin/afconvert';
const EXE = process.platform === 'win32' ? '.exe' : '';

class ConverterMissing extends Error {
  constructor(ext) {
    super(`Can't decode .${ext} files without ffmpeg — install it (e.g. winget install ffmpeg) or set SM_FFMPEG to its path`);
    this.code = 'ECONVERTER';
  }
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

let found; // undefined: not looked yet; null: none

// ffmpeg to use: $SM_FFMPEG, else one shipped next to the app
// (resources/ffmpeg[.exe]), else the first on PATH. Looked up once.
function ffmpegPath() {
  if (found !== undefined) return found;
  const candidates = [];
  if (process.env.SM_FFMPEG) candidates.push(process.env.SM_FFMPEG);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg' + EXE));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir.replace(/^"(.*)"$/, '$1'), 'ffmpeg' + EXE));
  }
  found = candidates.find(isFile) || null;
  return found;
}

const useAfconvert = () => process.platform === 'darwin' && isFile(AFCONVERT);

// Can anything here convert? (Tests skip the conversion cases without one.)
const available = () => useAfconvert() || !!ffmpegPath();

function run(bin, args, signal, name) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal, windowsHide: true }, (err, _o, stderr) =>
      err ? reject(err.name === 'AbortError' ? err : new Error(`${name} failed: ${stderr || err.message}`)) : resolve());
  });
}

// Decode `input` into a WAV file at `output`, at its own sample rate:
// sampleFormat 'f32' (32-bit float — what lossy codecs decode to, without
// clipping above 0 dBFS) or 's24' (24-bit PCM). `signal` aborts it.
function toWav(input, output, sampleFormat, signal) {
  if (useAfconvert()) {
    return run(AFCONVERT, ['-f', 'WAVE', '-d', sampleFormat === 'f32' ? 'LEF32' : 'LEI24', input, output], signal, 'afconvert');
  }
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return Promise.reject(new ConverterMissing(path.extname(input).slice(1).toLowerCase()));
  const codec = sampleFormat === 'f32' ? 'pcm_f32le' : 'pcm_s24le';
  return run(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', codec, '-f', 'wav', output], signal, 'ffmpeg');
}

module.exports = { toWav, available, ffmpegPath, ConverterMissing };
