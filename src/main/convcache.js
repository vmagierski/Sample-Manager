const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// CAF → WAV conversions kept on disk, so a sample is converted once rather
// than on every audition (by either window) and every crop. Keyed by path,
// size and mtime: an edited file gets a new entry, the old one ages out.
// Least recently used entries go once the folder passes its size cap.
// Unconfigured (unit tests), nothing is cached.

let dir = null;
let cap = 0;
let total = 0;

function configure(cacheDir, capBytes) {
  dir = cacheDir;
  cap = capBytes;
  fs.mkdirSync(dir, { recursive: true });
  prune();
}

function keyFor(filePath, st) {
  return crypto.createHash('sha1').update(`${filePath}\0${st.size}\0${Math.round(st.mtimeMs)}`).digest('hex');
}

// Path of the cached conversion, or null. A hit counts as a use (mtime = now).
function lookup(key) {
  if (!dir) return null;
  const file = path.join(dir, key + '.wav');
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
    return file;
  } catch {
    return null;
  }
}

// Where a conversion should write before commit(): a unique name in the cache
// folder, so the final rename is atomic.
function tempFor(key) {
  fs.mkdirSync(dir, { recursive: true }); // in case it was cleared while we ran
  return path.join(dir, `${key}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

function commit(key, tmp) {
  const file = path.join(dir, key + '.wav');
  fs.renameSync(tmp, file);
  try {
    total += fs.statSync(file).size;
  } catch {}
  if (total > cap) prune();
  return file;
}

// Delete least recently used entries (and stray temp files) until the folder
// fits the cap. Runs at configure and whenever a write pushes it over.
function prune() {
  if (!dir) return 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const entries = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      // Temp files of a conversion still running are young; older ones were orphaned.
      if (name.endsWith('.tmp')) {
        if (Date.now() - st.mtimeMs > 3600e3) fs.unlinkSync(file);
        continue;
      }
      if (name.endsWith('.wav')) entries.push({ file, size: st.size, used: st.mtimeMs });
    } catch {}
  }
  entries.sort((a, b) => a.used - b.used);
  total = entries.reduce((n, e) => n + e.size, 0);
  let removed = 0;
  // Down to 90% of the cap, so one more write doesn't prune again right away.
  for (const e of entries) {
    if (total <= cap * 0.9) break;
    try {
      fs.unlinkSync(e.file);
      total -= e.size;
      removed++;
    } catch {}
  }
  return removed;
}

const enabled = () => !!dir;

module.exports = { configure, keyFor, lookup, tempFor, commit, prune, enabled };
