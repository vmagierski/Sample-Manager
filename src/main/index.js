const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const drag = require('./drag');
const crop = require('./crop');
const quick = require('./quick');
const library = require('./library');
const lookup = require('./lookup');
const kits = require('./kits');

// Same library for `npm start` and the installed .app (whose productName would
// otherwise give it a different userData folder). Override for a throwaway
// library: SM_USER_DATA=/tmp/x npm start
app.setPath('userData', process.env.SM_USER_DATA || path.join(app.getPath('appData'), 'sample-manager'));

// In dev, edit the repo's tag-rules.json. The packaged app can't write inside
// its bundle, so it seeds an editable copy in userData on first launch.
const BUNDLED_RULES = path.join(__dirname, '..', '..', 'tag-rules.json');
const RULES_PATH = app.isPackaged ? path.join(app.getPath('userData'), 'tag-rules.json') : BUNDLED_RULES;
if (app.isPackaged && !fs.existsSync(RULES_PATH)) {
  fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
  fs.copyFileSync(BUNDLED_RULES, RULES_PATH);
}

// CAF → WAV conversions, kept across launches (convcache.js).
const CONVERTED_DIR = process.env.SM_CACHE_DIR || path.join(app.getPath('home'), 'Library', 'Caches', 'Sample Manager', 'Converted');
const CONVERTED_CAP = 2 * 1024 ** 3;

// ~/Music/Sample Manager is the app's own folder; Rec / Recall save into its
// Recordings subfolder by default. It's added to the library once (by the
// worker), so saved files are indexed (and tagged "recorded" by
// tag-rules.json) automatically.
const APP_MUSIC_DIR = path.join(app.getPath('home'), 'Music', 'Sample Manager');
const RECORD_DIR = path.join(APP_MUSIC_DIR, 'Recordings');

// Kits are folders of copies inside it: Kits/<name>/ (SM_KITS_DIR for tests).
const KITS_DIR = process.env.SM_KITS_DIR || path.join(APP_MUSIC_DIR, 'Kits');
// Library paths are real paths, so compare against the folder's too.
const realKitsDir = () => {
  try {
    return fs.realpathSync(KITS_DIR);
  } catch {
    return KITS_DIR;
  }
};

const DB_FILE = path.join(app.getPath('userData'), 'library.db');

let win = null;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// The library worker (library-worker.js) does the scanning; it asks main
// only for what needs a dialog.
library.on('unreadable', (folder) => {
  dialog
    .showMessageBox(win, {
      type: 'warning',
      message: `Sample Manager can't read “${folder.label}”`,
      detail:
        `${folder.path}\n\nmacOS protects this folder. To include it, turn on Sample Manager under ` +
        'System Settings → Privacy & Security → Full Disk Access, then quit and reopen Sample Manager.',
      buttons: ['Open Privacy Settings', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    });
});
library.on('rulesError', (message) => dialog.showErrorBox('tag-rules.json', `Couldn't load tag rules:\n${message}`));

const rescanAll = () => library.call('rescanAll').catch((err) => console.error('rescan failed:', err));

// --- folders ----------------------------------------------------------------

const addFolderPath = (picked) => library.call('addFolderPath', picked).catch((err) => ({ error: err.message }));

async function pickAndAddFolders() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add sample folder',
    properties: ['openDirectory', 'multiSelections', 'createDirectory'],
  });
  if (res.canceled) return { added: [], errors: [] };
  const added = [];
  const errors = [];
  let existing = null;
  for (const p of res.filePaths) {
    const r = await addFolderPath(p);
    if (r.error) errors.push(`${p}: ${r.error}`);
    else if (r.existing) existing = r.existing;
    else added.push(r.folder);
  }
  if (existing && win && !win.isDestroyed()) win.webContents.send('ui:showInSidebar', `${existing}/x`);
  if (errors.length) dialog.showMessageBox(win, { type: 'warning', message: 'Some folders were not added', detail: errors.join('\n') });
  return { added, errors };
}

async function removeFolder(id) {
  const folder = lookup.getFolder(id);
  if (!folder) return false;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Remove', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Remove “${folder.label}” from the library?`,
    detail: `${folder.path}\n\nFiles on disk are not touched, but tags you added to these samples will be lost.`,
  });
  if (response !== 0) return false;
  return library.call('removeFolder', id);
}

// --- IPC ----------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('folder:add', () => pickAndAddFolders());
  ipcMain.handle('folder:remove', (_e, id) => removeFolder(id));
  ipcMain.handle('recording:save', (_e, bytes, name) => saveRecording(bytes, name));
  ipcMain.handle('library:rescan', () => rescanAll());
  ipcMain.on('app:openMain', () => {
    quick.hide();
    openMainWindow();
  });
  ipcMain.handle('crop:prepare', (_e, id, start, end) => crop.prepare(id, +start, +end));
  ipcMain.handle('crop:clear', (_e, id) => crop.clear(id));
  ipcMain.handle('crop:save', async (_e, id) => {
    const name = crop.suggestedName(id);
    if (!name) return null;
    const res = await dialog.showSaveDialog(win, {
      title: 'Save crop',
      defaultPath: path.join(app.getPath('desktop'), name),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    });
    if (res.canceled || !res.filePath) return null;
    return crop.saveTo(id, res.filePath);
  });
  ipcMain.handle('sample:reveal', (_e, id) => {
    const row = lookup.getById(id);
    if (row) shell.showItemInFolder(row.path);
  });
  ipcMain.handle('kit:dir', () => realKitsDir());
  ipcMain.handle('kit:add', (e, ids, kit, create) => addToKit(e.sender, ids, kit, create));
  ipcMain.handle('kit:rename', (_e, from, to) => library.call('renameKit', from, to));
  ipcMain.on('sample:contextMenu', (e, ids) => sampleMenu(e.sender, ids));
  ipcMain.on('dir:contextMenu', (e, dir) => dirMenu(e.sender, dir));
  ipcMain.on('tag:contextMenu', (e, name) => tagMenu(e.sender, name));
  ipcMain.on('rail:foldersMenu', (e, at, state) => foldersMenu(e.sender, at, state));
  drag.register({ kitsDir: realKitsDir });
}

// --- recordings -----------------------------------------------------------------

async function saveRecording(bytes, name) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const safe = String(name || 'Recording.wav').replace(/[/:]/g, '-');
  const res = await dialog.showSaveDialog(win, {
    title: 'Save recording',
    defaultPath: path.join(RECORD_DIR, safe),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.promises.writeFile(res.filePath, Buffer.from(bytes));
  // Indexed right away (the watcher would get there too, but ~1s later), so
  // the page can select it. Null id if it was saved outside the library.
  const id = await library.call('indexNow', res.filePath).catch(() => null);
  return { path: res.filePath, id };
}

// --- kits -----------------------------------------------------------------------

// Copy samples into a kit (the library worker does the copying and indexing)
// and tell the page how it went. Samples with a crop region copy as that
// region. Resolves with the worker's result, or { error }.
async function addToKit(sender, ids, kit, create) {
  const items = [].concat(ids || []).map((id) => ({ id, ...crop.region(id) }));
  try {
    const res = await library.call('copyToKit', { kit, create: !!create, items });
    if (!sender.isDestroyed()) sender.send('ui:kitDone', { ...res, created: !!create });
    if (res.failed.length) {
      const shown = res.failed.slice(0, 8).map((f) => `${f.name}: ${f.error}`);
      if (res.failed.length > shown.length) shown.push(`…and ${res.failed.length - shown.length} more`);
      dialog.showMessageBox(win, {
        type: 'warning',
        message: `${res.copied ? 'Some sounds' : 'No sounds'} could not be copied to “${res.kit}”`,
        detail: shown.join('\n'),
      });
    }
    return res;
  } catch (err) {
    dialog.showErrorBox('Kit', err.message);
    return { error: err.message };
  }
}

// Kits can be created from a page's dialog (it asks for the name); the menu
// items just tell the page which samples to use.
async function kitSubmenu(sender, ids) {
  const names = await library.call('listKits').catch(() => []);
  return names.map((name) => ({ label: name, click: () => addToKit(sender, ids, name, false) }));
}

// Move files to the Trash (reversible), then tell the page.
async function trashFiles(sender, files, what) {
  let n = 0;
  for (const f of files) {
    try {
      await shell.trashItem(f);
      n++;
    } catch (err) {
      console.error(`trash ${f} failed:`, err.message);
    }
  }
  if (!sender.isDestroyed()) {
    sender.send('ui:flash', n === files.length ? `Moved ${what(n)} to the Trash` : `Moved ${n} of ${files.length} to the Trash`);
  }
}

// --- context menus --------------------------------------------------------------

async function sampleMenu(sender, ids) {
  const rows = [].concat(ids || []).map((id) => lookup.getById(id)).filter(Boolean);
  if (!rows.length) return;
  const many = rows.length > 1;
  const kitIds = rows.map((r) => r.id);
  const existing = await kitSubmenu(sender, kitIds);
  const root = realKitsDir();
  const inKits = rows.every((r) => kits.kitOf(root, r.path));
  Menu.buildFromTemplate([
    // Finder can only be asked to reveal one item; with a multi-selection, the first.
    { label: 'Show in Finder', accelerator: 'Alt+CmdOrCtrl+R', click: () => shell.showItemInFolder(rows[0].path) },
    {
      label: many ? `Copy ${rows.length} Paths` : 'Copy Path',
      click: () => clipboard.writeText(rows.map((r) => r.path).join('\n')),
    },
    { label: 'Show in Sidebar', click: () => sender.send('ui:showInSidebar', rows[0].path) },
    { type: 'separator' },
    { label: 'Edit Tags…', enabled: !many, click: () => sender.send('ui:editTags', rows[0].id) },
    { type: 'separator' },
    { label: 'New Kit from Selection…', accelerator: 'CmdOrCtrl+K', click: () => sender.send('ui:newKit', kitIds) },
    { label: 'Add to Kit', enabled: existing.length > 0, submenu: existing },
    // Only files inside a kit folder: the library's own samples stay put.
    ...(inKits
      ? [
          { type: 'separator' },
          {
            label: many ? `Remove ${rows.length} from Kit` : 'Remove from Kit',
            click: () => trashFiles(sender, rows.map((r) => r.path), (n) => `${n} ${n === 1 ? 'sound' : 'sounds'}`),
          },
        ]
      : []),
  ]).popup({ window: BrowserWindow.fromWebContents(sender) });
}

function tagMenu(sender, name) {
  if (typeof name !== 'string' || !name) return;
  Menu.buildFromTemplate([
    {
      label: `Delete Tag “${name}”…`,
      click: async () => {
        const inRules = await library.call('isRuleTag', name).catch(() => false);
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Delete Tag', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: `Delete the tag “${name}”?`,
          detail:
            'It is removed from every sample that has it. Files are not touched.' +
            (inRules
              ? '\n\nThis tag comes from tag-rules.json, so the next rescan will bring it back. ' +
                'Remove it there (File → Edit Tag Rules…) to get rid of it for good.'
              : ''),
        });
        if (response !== 0) return;
        library.call('deleteTag', name).catch((err) => console.error('delete tag failed:', err));
      },
    },
  ]).popup({ window: BrowserWindow.fromWebContents(sender) });
}

// The clickable "Folders ▾" header.
function foldersMenu(sender, at, { expanded = false, selected = false } = {}) {
  Menu.buildFromTemplate([
    { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => pickAndAddFolders() },
    { label: 'Rescan Library', accelerator: 'CmdOrCtrl+Shift+R', click: () => rescanAll() },
    { type: 'separator' },
    { label: 'Collapse All', enabled: expanded, click: () => sender.send('ui:folders', 'collapse') },
    { label: 'Deselect All', enabled: selected, click: () => sender.send('ui:folders', 'deselect') },
  ]).popup({
    window: BrowserWindow.fromWebContents(sender),
    x: Math.round(at?.x ?? 0),
    y: Math.round(at?.y ?? 0),
  });
}

function dirMenu(sender, dir) {
  // Only folders inside the library, not arbitrary paths from the renderer.
  if (typeof dir !== 'string') return;
  const folders = lookup.listFolders();
  const inLibrary = folders.some((f) => dir === f.path || dir.startsWith(f.path + path.sep));
  if (!inLibrary) return;
  const root = folders.find((f) => f.path === dir);
  const hidden = lookup.listHidden();
  const isHidden = hidden.includes(dir);
  const parentHidden = hidden.some((h) => dir.startsWith(h + path.sep));
  const changed = (method) => () => library.call(method, dir).catch((err) => console.error(`${method} failed:`, err));
  const kit = kits.isKitDir(realKitsDir(), dir) ? path.basename(dir) : null;
  const template = [
    { label: 'Show in Finder', enabled: fs.existsSync(dir), click: () => shell.openPath(dir) },
    { label: 'Copy Path', click: () => clipboard.writeText(dir) },
    ...(kit
      ? [
          { type: 'separator' },
          { label: 'Rename Kit…', click: () => sender.send('ui:renameKit', kit) },
          { label: 'Delete Kit…', click: () => deleteKit(sender, dir) },
        ]
      : []),
    { type: 'separator' },
    isHidden
      ? { label: 'Unhide', click: changed('unhideDir') }
      : parentHidden
        ? { label: 'Hidden (inside a hidden folder)', enabled: false }
        : { label: 'Hide from Library', click: changed('hideDir') },
  ];
  if (root) template.push({ label: 'Remove from Library…', click: () => removeFolder(root.id) });
  Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(sender) });
}

async function deleteKit(sender, dir) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Move to Trash', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Delete the kit “${path.basename(dir)}”?`,
    detail: 'The kit folder and the copies in it move to the Trash. The original samples are not touched.',
  });
  if (response !== 0) return;
  try {
    await shell.trashItem(dir);
    if (!sender.isDestroyed()) sender.send('ui:flash', `Deleted kit “${path.basename(dir)}”`);
  } catch (err) {
    dialog.showErrorBox('Delete Kit', err.message);
  }
}

// --- window & menu ------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // ⌘Q only closes the window: the app keeps running in the menu bar
        // (Quick Search hotkey, folder watching). ⌥⌘Q quits for real.
        { label: 'Close to Menu Bar', accelerator: 'CmdOrCtrl+Q', click: () => win && win.close() },
        { label: `Quit ${app.name} Completely`, accelerator: 'Alt+CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => pickAndAddFolders() },
        {
          label: 'Quick Search',
          // Shown for reference; the global hotkey itself is registered by quick.js.
          accelerator: quick.hotkey() || undefined,
          registerAccelerator: false,
          click: () => quick.show(),
        },
        { label: 'Rescan Library', accelerator: 'CmdOrCtrl+Shift+R', click: () => rescanAll() },
        { type: 'separator' },
        // The page knows the selection; with none it says so.
        { label: 'New Kit from Selection…', accelerator: 'CmdOrCtrl+K', click: () => send('ui:newKit') },
        { type: 'separator' },
        { label: 'Edit Tag Rules…', click: () => shell.openPath(RULES_PATH) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      // Undo / Redo: in the main window the page decides — text-field undo
      // while typing, otherwise undo the last tag edit. Elsewhere: native.
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: (_i, w) => (w === win ? send('ui:undo', false) : w && w.webContents.undo()),
        },
        {
          label: 'Redo',
          accelerator: 'Shift+CmdOrCtrl+Z',
          click: (_i, w) => (w === win ? send('ui:undo', true) : w && w.webContents.redo()),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every page (main window, Quick Search) gets a port to the library worker,
// and is reloaded if its renderer crashes rather than left blank — but not in
// a loop: one that dies again within 10 s stays down.
function connectPage(wc) {
  library.connectWindow(wc);
  let lastReload = 0;
  wc.on('render-process-gone', (_e, { reason }) => {
    if (reason === 'clean-exit' || wc.isDestroyed()) return;
    if (Date.now() - lastReload < 10e3) return console.error(`page crashed again (${reason}); not reloading`);
    lastReload = Date.now();
    console.error(`page crashed (${reason}); reloading`);
    wc.reload();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 420,
    backgroundColor: '#16171b',
    title: 'Sample Manager',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  connectPage(win.webContents);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
    setDockPresence(false); // back to the menu bar only
  });
}

// Bring up the main window (recreating it if it was closed — the app keeps
// running in the menu bar). Resolves once its page has loaded.
// Menu-bar app: with the main window closed the app lives only in the menu
// bar ("accessory": no ⌘Tab entry, no Dock icon); while the window is open
// it's a normal app you can ⌘Tab to.
function setDockPresence(on) {
  if (process.platform === 'darwin') app.setActivationPolicy(on ? 'regular' : 'accessory');
}

function openMainWindow() {
  setDockPresence(true);
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  return new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
    else resolve();
  });
}

// From Quick Search: show this sample in the main window.
async function openInMain(id, filePath) {
  await openMainWindow();
  send('ui:reveal', { id, path: filePath });
}

// One copy only: a second launch just brings up the running one.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => openMainWindow());

app.whenReady().then(() => {
  // The database, scanning and watching live in the library worker; main
  // only reads (lookup.js) for drags and menus.
  lookup.open(DB_FILE);
  library
    .init({
      dbFile: DB_FILE,
      rulesPath: RULES_PATH,
      cacheDir: CONVERTED_DIR,
      cacheCap: CONVERTED_CAP,
      appMusicDir: APP_MUSIC_DIR,
      recordDir: RECORD_DIR,
      kitsDir: KITS_DIR,
      appMusicMarker: path.join(app.getPath('userData'), '.added-app-music-dir'),
    })
    .catch((err) => console.error('library worker failed to start:', err));
  crop.prune(); // dragged crops are only kept for a week
  setInterval(() => crop.prune(), 86400e3).unref();
  registerIpc();
  // Quick Search first, then the main window (setting the panel up can touch
  // window visibility on macOS).
  quick.init({
    preload: path.join(__dirname, '..', 'preload.js'),
    rendererDir: path.join(__dirname, '..', 'renderer'),
    openMain: openInMain,
    openMainWindow,
    connectPage,
  });
  buildMenu();
  // Opened at login (or SM_START_HIDDEN): start quietly in the menu bar.
  // Otherwise — launched from Spotlight, Finder, the Dock — show the window.
  const atLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  if (atLogin || process.env.SM_START_HIDDEN) setDockPresence(false);
  else openMainWindow();

  // Launching the app again (Spotlight, Finder, Launchpad) while it runs in
  // the menu bar: macOS sends a "reopen" → 'activate' → show the window.
  // (Not 'did-become-active': the app also becomes active as it launches,
  // which would defeat starting hidden at login.)
  app.on('activate', () => openMainWindow());
});

// Closing the window doesn't quit: the app stays in the menu bar so the Quick
// Search hotkey keeps working. ⌘Q (or the menu-bar icon → Quit) quits.
app.on('window-all-closed', () => {});

// Quit in one go. (Cancelling the first quit to await async cleanup and then
// re-quitting got swallowed when quitting from the menu-bar menu, so it took
// two Quits.) The worker is told to stop watching and close the database,
// without waiting for it.
app.on('before-quit', () => {
  quick.dispose();
  crop.clearAll();
  library.shutdown();
});
app.on('will-quit', () => lookup.close());
