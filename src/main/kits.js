const path = require('path');

// Kits: plain folders of audio files under the app's music folder
// (~/Music/Sample Manager/Kits/<name>). The pure parts live here — names,
// collisions, defaults — so they can be tested without Electron or a library.

const NAME_MAX = 100;

// A name that is safe as a single path component on macOS (and when the kit is
// copied to other systems): no separators or control characters, no leading
// dots (hidden files are skipped by the scanner), no trailing dots or spaces.
// '' if nothing usable is left.
function safeName(name) {
  const s = String(name == null ? '' : name)
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .slice(0, NAME_MAX)
    .replace(/[.\s]+$/, '');
  return s === '..' ? '' : s;
}

// "Kick.wav" → "Kick 2.wav", "Kick 3.wav"… until it isn't in `taken` (a Set
// of lower-cased names: the volume is case-insensitive). The result is added.
function uniqueName(filename, taken) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let out = filename;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${base} ${n}${ext}`;
  taken.add(out.toLowerCase());
  return out;
}

// Name of the WAV a crop of `source` becomes, in a kit or when dragged out.
function cropFileName(source, start, end) {
  const base = path.basename(source, path.extname(source));
  return `${base} [${start.toFixed(2)}-${end.toFixed(2)}s].wav`;
}

// A starting name for a kit made from `rows` ({ path, tags }): the folder they
// all share, else a tag they all share, else "Kit 1", "Kit 2"… Never one that
// `existing` (kit names) already has: "Snares" → "Snares 2".
function defaultKitName(rows, existing = []) {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const free = (n) => !taken.has(n.toLowerCase());
  let base = '';
  if (rows.length) {
    const dirs = new Set(rows.map((r) => path.dirname(r.path)));
    if (dirs.size === 1) base = safeName(path.basename([...dirs][0]));
    if (!base) {
      const common = (rows[0].tags || []).find((t) => rows.every((r) => (r.tags || []).includes(t)));
      if (common) base = safeName(common.charAt(0).toUpperCase() + common.slice(1));
    }
  }
  if (base) {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} ${n}`;
      if (free(name)) return name;
    }
  }
  for (let n = 1; ; n++) if (free(`Kit ${n}`)) return `Kit ${n}`;
}

// The kit folder (direct child of kitsDir) that `p` is, or is inside; null if
// it isn't in a kit.
function kitOf(kitsDir, p) {
  const rel = path.relative(kitsDir, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return path.join(kitsDir, rel.split(path.sep)[0]);
}

// A kit folder itself (not a file or subfolder inside one).
const isKitDir = (kitsDir, p) => kitOf(kitsDir, p) === p;

module.exports = { safeName, uniqueName, cropFileName, defaultKitName, kitOf, isKitDir, NAME_MAX };
