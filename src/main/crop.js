const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const db = require('./db');
const { cropToWav } = require('./audio');

// Crops dragged into a DAW land here, outside the library: they're not
// kept. Logic copies a dropped file into the project when it's saved (File ›
// Project Settings › Assets › "Copy audio files into project"), so a crop
// only has to outlive that — it's deleted KEEP_DAYS after its last drag.
// Not a temp dir: macOS clears those on its own schedule. Use Save… to keep one.
const CROP_DIR = process.env.SM_CROP_DIR || path.join(app.getPath('home'), 'Library', 'Caches', 'Sample Manager', 'Crops');
const KEEP_DAYS = 7;

// Regions set in the player are rendered to a temp file right away, so a drag
// only has to copy a finished file. id -> { start, end, file: Promise<tmpPath> }
const pending = new Map();
let seq = 0;

function prepare(id, start, end) {
  clear(id);
  const row = db.getById(id);
  if (!row) return Promise.reject(new Error('unknown sample'));
  if (!(end > start)) return Promise.reject(new Error('empty region'));
  const file = cropToWav(row.path, start, end).then(async (buf) => {
    const tmp = path.join(os.tmpdir(), `sm-crop-${process.pid}-${++seq}.wav`);
    await fs.promises.writeFile(tmp, buf);
    return tmp;
  });
  pending.set(id, { start, end, file, source: row.path });
  file.catch(() => pending.get(id)?.file === file && pending.delete(id));
  return file.then(() => true);
}

function clear(id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  p.file.then((tmp) => fs.promises.unlink(tmp)).catch(() => {});
}

function clearAll() {
  for (const id of [...pending.keys()]) clear(id);
}

const has = (id) => pending.has(id);

function cropName(source, start, end) {
  const base = path.basename(source, path.extname(source));
  return `${base} [${start.toFixed(2)}-${end.toFixed(2)}s].wav`;
}

// Final file for a drag. The same region of the same sample always maps to the
// same name, so dragging it twice doesn't pile up copies.
async function materialize(id) {
  const p = pending.get(id);
  const tmp = await p.file;
  fs.mkdirSync(CROP_DIR, { recursive: true });
  const dest = path.join(CROP_DIR, cropName(p.source, p.start, p.end));
  if (!fs.existsSync(dest)) fs.copyFileSync(tmp, dest);
  else {
    const now = new Date();
    fs.utimesSync(dest, now, now); // dragged again: restart its week
  }
  return dest;
}

// Delete crops last dragged more than KEEP_DAYS ago. Runs at launch and daily.
function prune(now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(CROP_DIR);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.wav')) continue;
    const file = path.join(CROP_DIR, name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_DAYS * 86400e3) {
        fs.unlinkSync(file);
        n++;
      }
    } catch {}
  }
  return n;
}

// "Save…": copy the rendered crop wherever the user picks.
async function saveTo(id, dest) {
  const p = pending.get(id);
  if (!p) throw new Error('no crop for this sample');
  await fs.promises.copyFile(await p.file, dest);
  return dest;
}

function suggestedName(id) {
  const p = pending.get(id);
  return p ? cropName(p.source, p.start, p.end) : null;
}

module.exports = { prepare, clear, clearAll, has, materialize, saveTo, suggestedName, prune, CROP_DIR, KEEP_DAYS };
