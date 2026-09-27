const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const db = require('./db');
const scanner = require('./scanner');
const drag = require('./drag');
const { LibraryWatcher } = require('./watcher');
const { readPlayable } = require('./audio');
const crop = require('./crop');

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

let win = null;
let watcher = null;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

let changeTimer = null;
function notifyChanged() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => send('library:changed'), 150);
}

// --- scanning (serialized so two walks never race on the same rows) --------

let scanQueue = Promise.resolve();
let scansPending = 0;

function enqueueScan(label, fn) {
  scansPending++;
  send('scan:status', { busy: true, label });
  const run = scanQueue.then(fn).catch((err) => console.error(`${label} failed:`, err));
  scanQueue = run.finally(() => {
    scansPending--;
    send('scan:status', scansPending ? { busy: true, label: 'Scanning…' } : { busy: false });
    notifyChanged();
  });
  return scanQueue;
}

// Folders we've already warned about this session.
const blockedWarned = new Set();

function warnUnreadable(folder, err) {
  if (blockedWarned.has(folder.id)) return;
  blockedWarned.add(folder.id);
  const privacy = err.code === 'EPERM' || err.code === 'EACCES';
  if (!privacy) {
    // e.g. an unplugged drive: keep its samples, just say so in the status line.
    send('scan:status', { busy: false, label: `${folder.label} is unavailable — kept its samples` });
    return;
  }
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
}

function scanFolder(folder) {
  return enqueueScan(`Scanning ${folder.label}…`, async () => {
    let files;
    try {
      files = await scanner.walk(folder.path);
    } catch (err) {
      console.warn(`scan: can't read ${folder.path}: ${err.message}`);
      warnUnreadable(folder, err);
      return; // leave its rows (and tags) untouched
    }
    if (!db.getFolder(folder.id)) return; // removed mid-scan
    db.syncFolder(folder.id, files, (p) => scanner.tagsFor(path.relative(folder.path, p), p));
  });
}

function loadRules() {
  try {
    scanner.loadRules(RULES_PATH);
    db.ensureTags(scanner.ruleTags()); // rule tags always show, even with no samples yet
  } catch (err) {
    dialog.showErrorBox('tag-rules.json', `Couldn't load tag rules:\n${err.message}`);
  }
}

function rescanAll() {
  loadRules();
  return Promise.all(db.listFolders().map(scanFolder));
}

// --- folders ----------------------------------------------------------------

async function addFolderPath(picked) {
  let real;
  try {
    real = fs.realpathSync(picked);
  } catch (err) {
    return { error: err.message };
  }
  const existing = db.listFolders();
  const covering = existing.find((f) => real === f.path || real.startsWith(f.path + path.sep));
  if (covering) return { error: `Already in your library via ${covering.path}` };

  const folder = db.addFolder(real, path.basename(real) || real);
  watcher.watch(folder);
  await scanFolder(folder);

  // Adding a parent of an existing folder absorbs it. The scan above already
  // re-pointed those samples at the parent (keeping their tags).
  for (const child of existing.filter((f) => f.path.startsWith(real + path.sep))) {
    await watcher.unwatch(child.id);
    db.removeFolder(child.id);
  }
  notifyChanged();
  return { folder };
}

async function pickAndAddFolders() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add sample folder',
    properties: ['openDirectory', 'multiSelections', 'createDirectory'],
  });
  if (res.canceled) return { added: [], errors: [] };
  const added = [];
  const errors = [];
  for (const p of res.filePaths) {
    const r = await addFolderPath(p);
    if (r.error) errors.push(`${p}: ${r.error}`);
    else added.push(r.folder);
  }
  if (errors.length) dialog.showMessageBox(win, { type: 'warning', message: 'Some folders were not added', detail: errors.join('\n') });
  return { added, errors };
}

async function removeFolder(id) {
  const folder = db.getFolder(id);
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
  await watcher.unwatch(id);
  db.removeFolder(id);
  notifyChanged();
  return true;
}

// --- IPC ----------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('folder:add', () => pickAndAddFolders());
  ipcMain.handle('folder:remove', (_e, id) => removeFolder(id));
  ipcMain.handle('folders:list', () => db.listFolders());
  ipcMain.handle('folders:dirs', () => db.listDirs());
  ipcMain.handle('folders:hidden', () => db.listHidden());
  ipcMain.handle('recording:save', (_e, bytes, name) => saveRecording(bytes, name));
  ipcMain.handle('library:rescan', () => rescanAll());
  ipcMain.handle('samples:list', (_e, filter) => db.listSamples(filter));
  ipcMain.handle('tags:list', () => db.listTags());
  ipcMain.handle('samples:tag', (_e, id, tags) => {
    const tagsOut = db.setTags(id, Array.isArray(tags) ? tags : []);
    send('tags:changed');
    return tagsOut;
  });
  ipcMain.handle('sample:duration', (_e, id, ms) => db.setDuration(id, ms));
  ipcMain.handle('crop:prepare', (_e, id, start, end) => crop.prepare(id, +start, +end));
  ipcMain.handle('crop:clear', (_e, id) => crop.clear(id));
  ipcMain.handle('sample:read', async (_e, id) => {
    const row = db.getById(id);
    if (!row) throw new Error('unknown sample');
    return readPlayable(row.path);
  });
  ipcMain.handle('sample:reveal', (_e, id) => {
    const row = db.getById(id);
    if (row) shell.showItemInFolder(row.path);
  });
  ipcMain.on('sample:contextMenu', (e, ids) => sampleMenu(e.sender, ids));
  ipcMain.on('dir:contextMenu', (e, dir) => dirMenu(e.sender, dir));
  ipcMain.on('tag:contextMenu', (e, name) => tagMenu(e.sender, name));
  ipcMain.on('rail:foldersMenu', (e, at, state) => foldersMenu(e.sender, at, state));
  drag.register();
}

// --- recordings -----------------------------------------------------------------

// ~/Music/Sample Manager is the app's own folder; Rec / Recall save into its
// Recordings subfolder by default. It's in the library, so saved files are
// indexed (and tagged "recorded" by tag-rules.json) automatically.
const APP_MUSIC_DIR = path.join(app.getPath('home'), 'Music', 'Sample Manager');
const RECORD_DIR = path.join(APP_MUSIC_DIR, 'Recordings');

// Once per library: create the folder and add it to the library. If you later
// remove it from the library, it stays removed. (The marker lives with the
// library, so a test library doesn't use up the real one's first run.)
function ensureAppMusicDir() {
  const marker = path.join(app.getPath('userData'), '.added-app-music-dir');
  if (fs.existsSync(marker)) return;
  try {
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    const real = fs.realpathSync(APP_MUSIC_DIR);
    const covered = db.listFolders().some((f) => real === f.path || real.startsWith(f.path + path.sep));
    if (!covered) db.addFolder(real, 'Sample Manager');
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (err) {
    console.warn(`couldn't set up ${APP_MUSIC_DIR}:`, err.message);
  }
}

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
  return { path: res.filePath, id: indexNow(res.filePath) };
}

// Add a file we just wrote to the library right away (the watcher would get
// there too, but ~1s later), so the page can select it. Null if it was saved
// outside every library folder.
function indexNow(filePath) {
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  const folder = db.listFolders().find((f) => real.startsWith(f.path + path.sep));
  if (!folder) return null;
  const st = fs.statSync(real);
  db.upsertFile(folder.id, { path: real, size: st.size, mtime: Math.round(st.mtimeMs) },
    scanner.tagsFor(path.relative(folder.path, real), real));
  notifyChanged();
  return db.getByPath(real).id;
}

// --- context menus --------------------------------------------------------------

function sampleMenu(sender, ids) {
  const rows = [].concat(ids || []).map((id) => db.getById(id)).filter(Boolean);
  if (!rows.length) return;
  const many = rows.length > 1;
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
  ]).popup({ window: BrowserWindow.fromWebContents(sender) });
}

function tagMenu(sender, name) {
  if (typeof name !== 'string' || !name) return;
  Menu.buildFromTemplate([
    {
      label: `Delete Tag “${name}”…`,
      click: async () => {
        const inRules = scanner.ruleTags().map(db.normalizeTag).includes(db.normalizeTag(name));
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
        db.deleteTag(name);
        notifyChanged();
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
  const folders = db.listFolders();
  const inLibrary = folders.some((f) => dir === f.path || dir.startsWith(f.path + path.sep));
  if (!inLibrary) return;
  const root = folders.find((f) => f.path === dir);
  const hidden = db.listHidden();
  const isHidden = hidden.includes(dir);
  const parentHidden = hidden.some((h) => dir.startsWith(h + path.sep));
  const changed = (fn) => () => {
    fn();
    notifyChanged();
  };
  const template = [
    { label: 'Show in Finder', enabled: fs.existsSync(dir), click: () => shell.openPath(dir) },
    { label: 'Copy Path', click: () => clipboard.writeText(dir) },
    { type: 'separator' },
    isHidden
      ? { label: 'Unhide', click: changed(() => db.unhideDir(dir)) }
      : parentHidden
        ? { label: 'Hidden (inside a hidden folder)', enabled: false }
        : { label: 'Hide from Library', click: changed(() => db.hideDir(dir)) },
  ];
  if (root) template.push({ label: 'Remove from Library…', click: () => removeFolder(root.id) });
  Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(sender) });
}

// --- window & menu ------------------------------------------------------------

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => pickAndAddFolders() },
        { label: 'Rescan Library', accelerator: 'CmdOrCtrl+Shift+R', click: () => rescanAll() },
        { type: 'separator' },
        { label: 'Edit Tag Rules…', click: () => shell.openPath(RULES_PATH) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  db.open(path.join(app.getPath('userData'), 'library.db'));
  loadRules();
  ensureAppMusicDir();
  watcher = new LibraryWatcher({ onChange: notifyChanged });
  registerIpc();
  buildMenu();
  createWindow();

  // Catch anything that changed while the app was closed, then keep watching.
  for (const folder of db.listFolders()) {
    watcher.watch(folder);
    scanFolder(folder);
  }

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  crop.clearAll();
  Promise.resolve(watcher && watcher.closeAll())
    .catch(() => {})
    .finally(() => {
      db.close();
      app.quit();
    });
});
