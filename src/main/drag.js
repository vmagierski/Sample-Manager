const fs = require('fs');
const { ipcMain, nativeImage } = require('electron');
const db = require('./db');

// macOS crashes the drag if the icon is empty, so we always pass this one.
// Drawn once at startup (a waveform glyph on a rounded tile) rather than
// shipped as a binary asset. 64px bitmap at scaleFactor 2 = 32pt on screen.
function makeDragIcon() {
  const S = 64;
  const buf = Buffer.alloc(S * S * 4); // BGRA
  const set = (x, y, [r, g, b, a]) => {
    const i = (y * S + x) * 4;
    buf[i] = b;
    buf[i + 1] = g;
    buf[i + 2] = r;
    buf[i + 3] = a;
  };
  const R = 12;
  const inTile = (x, y) => {
    const cx = Math.min(Math.max(x, R), S - 1 - R);
    const cy = Math.min(Math.max(y, R), S - 1 - R);
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
  };
  const bars = [10, 22, 34, 18, 40, 26, 14, 30, 20, 8];
  const barW = 3;
  const gap = 2;
  const x0 = Math.round((S - (bars.length * (barW + gap) - gap)) / 2);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inTile(x, y)) continue;
      set(x, y, [30, 32, 38, 230]);
      const bi = Math.floor((x - x0) / (barW + gap));
      const inBar = x >= x0 && bi < bars.length && (x - x0) % (barW + gap) < barW;
      if (inBar && Math.abs(y - S / 2) <= bars[bi] / 2) set(x, y, [255, 170, 60, 255]);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
}

function register() {
  const icon = makeDragIcon();
  if (icon.isEmpty()) throw new Error('drag icon is empty — startDrag would crash on macOS');

  // Accepts one path or an array (multi-select drag). Only files we indexed
  // and that still exist are handed to the OS.
  ipcMain.on('sample:startDrag', (event, paths) => {
    const files = [].concat(paths || []).filter((p) => typeof p === 'string' && db.hasPath(p) && fs.existsSync(p));
    if (!files.length) return;
    event.sender.startDrag({ file: files[0], files, icon });
  });
}

module.exports = { register };
