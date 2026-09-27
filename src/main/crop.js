const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const db = require('./db');
const { cropToWav } = require('./audio');

// Crops dragged into a DAW land here, not in a temp dir: Logic may reference
// the dropped file in place, so it has to stay put. It's inside the library,
// so crops also show up in the list (tagged "crop" by tag-rules.json).
const CROP_DIR = process.env.SM_CROP_DIR || path.join(app.getPath('home'), 'Music', 'Sample Manager', 'Crops');

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
  return dest;
}

module.exports = { prepare, clear, clearAll, has, materialize, CROP_DIR };
