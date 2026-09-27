const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } = require('electron');

// Quick Search: a Spotlight-style panel on a global hotkey. Search the library,
// arrow through results to audition them, drag one straight into the DAW, or
// open it in the main window. The app keeps running in the menu bar when its
// window is closed so the hotkey always works.

// ⌘Space is Spotlight and ⌥⌘Space the Finder search window, so default to
// ⌃⌥Space. Override with {"quickSearchHotkey": "…"} in settings.json (userData).
const DEFAULT_HOTKEY = 'Control+Alt+Space';

let panel = null;
let tray = null;
let hotkey = null; // registered accelerator, or null if registration failed
let opts = null; // { preload, rendererDir, openMain(id, path), openMainWindow() }

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function prettyHotkey(acc) {
  if (!acc) return '';
  const map = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Space: 'Space' };
  return acc.split('+').map((k) => map[k] ?? k).join('');
}

function createPanel() {
  panel = new BrowserWindow({
    // An NSPanel: floats over other apps (full-screen Logic included) and takes
    // typing without making Sample Manager the active app, so the DAW stays
    // frontmost for the drop.
    type: 'panel',
    width: 720,
    height: 470,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#1d1f24',
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // skipTransformProcessType: without it Electron switches the whole app to a
  // background "UIElement" app to do this — which then stayed that way: no
  // ⌘Tab entry, no Dock icon, and relaunching from Spotlight showed nothing.
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  panel.setAlwaysOnTop(true, 'floating');
  panel.loadFile(path.join(opts.rendererDir, 'quick.html'));
  // Like Spotlight: clicking anywhere else dismisses it. (A drag into the DAW
  // doesn't move focus, so the panel stays until you click elsewhere.)
  panel.on('blur', hide);
  panel.on('closed', () => {
    panel = null;
  });
}

function show() {
  if (!panel) createPanel();
  // Centre on the screen the mouse is on, in the upper third.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w] = panel.getSize();
  panel.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height * 0.18));
  panel.show();
  panel.focus();
  const tell = () => panel && panel.webContents.send('quick:shown');
  if (panel.webContents.isLoading()) panel.webContents.once('did-finish-load', tell);
  else tell();
}

function hide() {
  if (!panel || !panel.isVisible()) return;
  panel.hide();
  panel.webContents.send('quick:hidden');
}

function toggle() {
  if (panel && panel.isVisible()) hide();
  else show();
}

function trayIcon() {
  // Template image (macOS tints it for light/dark menu bars): a waveform glyph.
  const S = 36; // 18pt @2x
  const buf = Buffer.alloc(S * S * 4);
  const bars = [8, 16, 26, 14, 30, 20, 10, 22, 12];
  const bw = 2;
  const gap = 2;
  const x0 = Math.round((S - (bars.length * (bw + gap) - gap)) / 2);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const bi = Math.floor((x - x0) / (bw + gap));
      const inBar = x >= x0 && bi < bars.length && (x - x0) % (bw + gap) < bw && Math.abs(y - S / 2) <= bars[bi] / 2;
      if (inBar) buf[(y * S + x) * 4 + 3] = 255; // black, opaque (BGRA: alpha last)
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function buildTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('Sample Manager');
  }
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: hotkey ? `Quick Search      ${prettyHotkey(hotkey)}` : 'Quick Search (hotkey unavailable)',
        click: show,
      },
      { label: 'Open Sample Manager', click: () => opts.openMainWindow() },
      { type: 'separator' },
      {
        label: 'Open at Login',
        type: 'checkbox',
        checked: login,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          buildTray();
        },
      },
      { type: 'separator' },
      // Explicit app.quit() (not role: 'quit'): the path verified to quit in one go.
      { label: 'Quit Sample Manager', click: () => app.quit() },
    ]),
  );
}

function init(o) {
  opts = o;
  const wanted = readSettings().quickSearchHotkey || DEFAULT_HOTKEY;
  // A test copy (SM_USER_DATA, or SM_NO_HOTKEY) mustn't grab the system-wide
  // hotkey from the real app running alongside it.
  const testCopy = process.env.SM_NO_HOTKEY || (process.env.SM_USER_DATA && !process.env.SM_HOTKEY);
  if (testCopy) {
    hotkey = null;
  } else try {
    hotkey = globalShortcut.register(wanted, toggle) ? wanted : null;
  } catch (err) {
    hotkey = null;
    console.warn(`quick search: bad hotkey "${wanted}": ${err.message}`);
  }
  if (!hotkey && !testCopy) console.warn(`quick search: couldn't register ${wanted} (taken by another app?)`);

  ipcMain.on('quick:hide', hide);
  ipcMain.on('quick:open', (_e, id, filePath) => {
    hide();
    opts.openMain(id, filePath);
  });

  buildTray();
  createPanel(); // warm it up so the first hotkey press is instant
}

function dispose() {
  globalShortcut.unregisterAll();
}

module.exports = { init, show, hide, toggle, dispose, prettyHotkey, hotkey: () => hotkey };
