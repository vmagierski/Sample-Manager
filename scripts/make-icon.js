// Renders build/icon.png (1024², macOS icon grid) with an offscreen canvas.
// Run: npx electron scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const draw = () => {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // Big Sur grid: 824px tile centered, ~185px corner radius, soft shadow.
  const x = 100, y = 100, w = 824, r = 185;
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 28;
  g.shadowOffsetY = 12;
  const bg = g.createLinearGradient(0, y, 0, y + w);
  bg.addColorStop(0, '#2b2e36');
  bg.addColorStop(1, '#131418');
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(x, y, w, w, r);
  g.fill();
  g.shadowColor = 'transparent';

  const bars = [0.18, 0.42, 0.7, 0.36, 0.86, 0.54, 0.28, 0.62, 0.4, 0.16];
  const bw = 44, gap = 26;
  const total = bars.length * bw + (bars.length - 1) * gap;
  const fg = g.createLinearGradient(0, 300, 0, 724);
  fg.addColorStop(0, '#ffc46b');
  fg.addColorStop(1, '#ff8a1f');
  g.fillStyle = fg;
  bars.forEach((b, i) => {
    const h = b * 520;
    g.beginPath();
    g.roundRect(S / 2 - total / 2 + i * (bw + gap), S / 2 - h / 2, bw, h, bw / 2);
    g.fill();
  });
  return c.toDataURL('image/png');
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const url = await win.webContents.executeJavaScript(`(${draw})()`);
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', out);
  app.quit();
});
