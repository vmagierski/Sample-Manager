// Builds a throwaway library for `npm run bench`:
//
//   <dir>/library.db   ~750k samples (DB only — the paths don't exist on disk),
//                      made through db.js so the schema and tagging are the
//                      app's own
//   <dir>/tree/        a real folder of small WAVs, for scan / rescan timing
//   <dir>/large/       a few long files (WAV, AIFF, AAC and ALAC CAF) for the
//                      playback and crop paths
//
// Run under Electron's Node (better-sqlite3 is built for Electron):
//   ELECTRON_RUN_AS_NODE=1 electron scripts/make-bench-library.js [--dir D] [--samples N]
//     [--tree-files N] [--large-min M] [--force]
// Each part is skipped if it already exists (unless --force).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const db = require(path.join(REPO, 'src/main/db'));
const scanner = require(path.join(REPO, 'src/main/scanner'));

function parseArgs(argv) {
  const opts = {
    dir: process.env.SM_BENCH_DIR || path.join(os.tmpdir(), 'sm-bench'),
    samples: 750_000,
    treeFiles: 30_000,
    largeMin: 30, // minutes of stereo 48k/24-bit audio in the big WAV (~500 MB)
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dir') opts.dir = path.resolve(next());
    else if (a === '--samples') opts.samples = +next();
    else if (a === '--tree-files') opts.treeFiles = +next();
    else if (a === '--large-min') opts.largeMin = +next();
    else if (a === '--force') opts.force = true;
  }
  return opts;
}

// --- deterministic names ------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJ = ['Dark', 'Warm', 'Vintage', 'Lofi', 'Analog', 'Deep', 'Bright', 'Dusty', 'Punchy', 'Crisp', 'Tape',
  'Vinyl', 'Soft', 'Hard', 'Wide', 'Gritty', 'Clean', 'Lush', 'Cosmic', 'Tight', 'Heavy', 'Airy', 'Metallic', 'Organic'];
const NOUNS = ['Kick', 'Snare', 'Hat', 'Open Hat', 'Clap', 'Tom', 'Rim', 'Shaker', 'Conga', 'Crash', 'Ride', 'Perc',
  'Bass', 'Sub', '808', 'Reese', 'Pad', 'Lead', 'Pluck', 'Arp', 'Chord', 'Keys', 'Piano', 'Strings', 'Brass',
  'Vox', 'Vocal Chop', 'Chant', 'Riser', 'Impact', 'Sweep', 'Whoosh', 'Texture', 'Drone', 'Atmo', 'Noise',
  'Foley', 'Break', 'Drum Loop', 'Top Loop', 'Groove', 'Fill', 'Guitar', 'Cello', 'Flute', 'Bell'];
const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const LABELS = ['Splice', 'Loopmasters', 'Samples From Mars', 'Cymatics', 'Black Octopus', 'Goldbaby', 'Sample Magic',
  'Prime Loops', 'Function Loops', 'Zero-G', 'Big Fish', 'Ghosthack', 'Producer Loops', 'Wave Alchemy'];
const GENRES = ['House', 'Techno', 'Hip Hop', 'Trap', 'DnB', 'Lofi', 'Ambient', 'Cinematic', 'Disco', 'Garage',
  'Dub', 'Jazz', 'Funk', 'Afro', 'Synthwave', 'Breaks', 'Minimal', 'Pop', 'RnB', 'Soul'];
const SUBDIRS = [
  ['Drums', 'Kicks'], ['Drums', 'Snares'], ['Drums', 'Hats'], ['Drums', 'Claps'], ['Drums', 'Percussion'],
  ['Drum Loops'], ['Top Loops'], ['Bass'], ['Bass Loops'], ['Synths', 'Pads'], ['Synths', 'Leads'],
  ['Synths', 'One Shots'], ['Music Loops'], ['Vocals'], ['FX', 'Risers'], ['FX', 'Impacts'], ['Textures'], ['Foley'],
];
const EXTS = ['wav', 'wav', 'wav', 'wav', 'aif', 'aif', 'caf', 'mp3'];

// Roots are virtual: under <dir>/virtual, which never exists on disk.
const ROOTS = [
  { label: 'Apple Loops', share: 0.12 },
  { label: 'Logic Factory', share: 0.18 },
  { label: 'User Library', share: 0.55 },
  { label: 'Logic', share: 0.1 },
  { label: 'Sample Manager', share: 0.05 },
];

function sampleName(r, noun, i) {
  const bits = [];
  if (r() < 0.6) bits.push(ADJ[Math.floor(r() * ADJ.length)]);
  bits.push(noun);
  const loop = /Loop|Break|Groove|Fill|Top|Arp|Chord/.test(noun) || r() < 0.2;
  if (loop) bits.push(`${70 + Math.floor(r() * 110)} BPM`);
  if (r() < 0.35) bits.push(KEYS[Math.floor(r() * KEYS.length)] + (r() < 0.5 ? 'm' : ''));
  bits.push(String(i).padStart(2, '0'));
  const sep = r() < 0.5 ? ' ' : '_';
  return bits.join(sep) + '.' + EXTS[Math.floor(r() * EXTS.length)];
}

// Yields { root, files } per watched root, files as { path, size, mtime }.
function* virtualLibrary(base, total) {
  const r = rng(42);
  let packSeq = 0;
  for (const root of ROOTS) {
    const rootPath = path.join(base, 'virtual', root.label);
    const want = Math.round(total * root.share);
    const files = [];
    while (files.length < want) {
      const label = LABELS[Math.floor(r() * LABELS.length)];
      const genre = GENRES[Math.floor(r() * GENRES.length)];
      const pack = `${label} - ${genre} ${ADJ[Math.floor(r() * ADJ.length)]} Vol ${++packSeq}`;
      const perPack = 150 + Math.floor(r() * 700);
      for (let k = 0; k < perPack && files.length < want; ) {
        const sub = SUBDIRS[Math.floor(r() * SUBDIRS.length)];
        const n = 5 + Math.floor(r() * 40);
        for (let i = 1; i <= n && k < perPack && files.length < want; i++, k++) {
          const noun = pickNoun(r, sub);
          const p = path.join(rootPath, pack, ...sub, sampleName(r, noun, i));
          files.push({ path: p, size: 20_000 + Math.floor(r() * 5_000_000), mtime: 1_600_000_000_000 + packSeq * 1000 });
        }
      }
    }
    yield { root: rootPath, label: root.label, files };
  }
}

function pickNoun(r, sub) {
  const leaf = sub[sub.length - 1];
  const bias = {
    Kicks: 'Kick', Snares: 'Snare', Hats: 'Hat', Claps: 'Clap', Pads: 'Pad', Leads: 'Lead', Vocals: 'Vox',
    Risers: 'Riser', Impacts: 'Impact', Textures: 'Texture', Foley: 'Foley', Bass: 'Bass',
    'Drum Loops': 'Drum Loop', 'Top Loops': 'Top Loop', 'Bass Loops': 'Bass',
  }[leaf];
  if (bias && r() < 0.7) return bias;
  return NOUNS[Math.floor(r() * NOUNS.length)];
}

// --- (a) the big DB ------------------------------------------------------------

function makeDb(opts) {
  const file = path.join(opts.dir, 'library.db');
  if (fs.existsSync(file) && !opts.force) return log(`library.db exists — skipped`);
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
  scanner.loadRules(path.join(REPO, 'tag-rules.json'));
  db.open(file);
  db.ensureTags(scanner.ruleTags());
  const t0 = Date.now();
  let n = 0;
  for (const { root, label, files } of virtualLibrary(opts.dir, opts.samples)) {
    const folder = db.addFolder(root, label);
    db.syncFolder(folder.id, files, (p) => scanner.tagsFor(path.relative(root, p), p));
    n += files.length;
    log(`  ${label}: ${files.length} samples`);
  }
  db.close();
  log(`library.db: ${n} samples in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// --- (b) real on-disk tree -----------------------------------------------------

// A valid 16-bit mono WAV with `frames` of silence.
function tinyWav(frames = 64) {
  const data = frames * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

function makeTree(opts) {
  const root = path.join(opts.dir, 'tree');
  if (fs.existsSync(path.join(root, '.done')) && !opts.force) return log('tree/ exists — skipped');
  fs.rmSync(root, { recursive: true, force: true });
  const wav = tinyWav();
  const t0 = Date.now();
  const made = new Set();
  let n = 0;
  const [{ files }] = virtualLibrary(opts.dir, opts.treeFiles / ROOTS[0].share);
  const from = path.join(opts.dir, 'virtual', ROOTS[0].label);
  for (const f of files) {
    const p = path.join(root, path.relative(from, f.path).replace(/\.\w+$/, '.wav'));
    const d = path.dirname(p);
    if (!made.has(d)) fs.mkdirSync(d, { recursive: true }), made.add(d);
    if (!fs.existsSync(p)) n++;
    fs.writeFileSync(p, wav);
  }
  fs.writeFileSync(path.join(root, '.done'), String(n));
  log(`tree/: ${n} files in ${made.size} folders, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// --- (c) large files -----------------------------------------------------------

// Stereo 48 kHz 24-bit WAV of a slowly swept tone plus noise, written in chunks.
function writeLongWav(file, minutes) {
  const rate = 48000;
  const ch = 2;
  const frames = Math.round(minutes * 60 * rate);
  const dataLen = frames * ch * 3;
  const fd = fs.openSync(file, 'w');
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + dataLen, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(ch, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * ch * 3, 28);
  head.writeUInt16LE(ch * 3, 32);
  head.writeUInt16LE(24, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(dataLen, 40);
  fs.writeSync(fd, head);
  const r = rng(7);
  const CH = 1 << 16;
  const buf = Buffer.alloc(CH * ch * 3);
  let phase = 0;
  for (let f0 = 0; f0 < frames; f0 += CH) {
    const n = Math.min(CH, frames - f0);
    for (let i = 0; i < n; i++) {
      const t = (f0 + i) / rate;
      phase += (2 * Math.PI * (110 + 40 * Math.sin(t / 7))) / rate;
      const v = 0.3 * Math.sin(phase) + 0.05 * (r() * 2 - 1);
      const s = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
      for (let c = 0; c < ch; c++) buf.writeIntLE(s, (i * ch + c) * 3, 3);
    }
    fs.writeSync(fd, buf, 0, n * ch * 3);
  }
  fs.closeSync(fd);
}

function makeLarge(opts) {
  const dir = path.join(opts.dir, 'large');
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'long.wav');
  const step = (file, what, fn) => {
    if (fs.existsSync(file) && !opts.force) return;
    const t0 = Date.now();
    const tmp = file + '.part' + path.extname(file);
    fn(tmp);
    fs.renameSync(tmp, file);
    log(`large/${path.basename(file)}: ${what}, ${mb(fs.statSync(file).size)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  };
  const afconvert = (args) => execFileSync('/usr/bin/afconvert', args, { stdio: 'inherit' });
  step(wav, `${opts.largeMin} min 48k/24-bit stereo`, (tmp) => writeLongWav(tmp, opts.largeMin));
  step(path.join(dir, 'long.aif'), 'same audio as AIFF', (tmp) => afconvert(['-f', 'AIFF', '-d', 'BEI24', wav, tmp]));
  step(path.join(dir, 'long-alac.caf'), 'same audio as ALAC CAF', (tmp) => afconvert(['-f', 'caff', '-d', 'alac', wav, tmp]));
  // AAC is slow to encode, so a shorter one: ~10 minutes.
  step(path.join(dir, 'medium-aac.caf'), '~10 min AAC CAF', (tmp) => {
    const cut = path.join(dir, 'cut.part.wav');
    writeLongWav(cut, Math.min(10, opts.largeMin));
    try {
      afconvert(['-f', 'caff', '-d', 'aac', '-b', '256000', cut, tmp]);
    } finally {
      fs.rmSync(cut, { force: true });
    }
  });
}

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
const log = (s) => process.stderr.write(s + '\n');

function make(opts) {
  fs.mkdirSync(opts.dir, { recursive: true });
  log(`bench library in ${opts.dir}`);
  makeDb(opts);
  makeTree(opts);
  makeLarge(opts);
}

module.exports = { make, parseArgs, tinyWav };

if (require.main === module) make(parseArgs(process.argv.slice(2)));
