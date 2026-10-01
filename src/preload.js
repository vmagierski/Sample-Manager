const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// The page's port to the library worker comes from main (on every page load
// and whenever the worker restarts). A MessagePort can't cross the context
// bridge, so it's posted to the page — once the page has asked, so its
// listener exists (see renderer/library.js, which builds window.sm).
let port = null;
let wanted = false;
function passPort() {
  if (!wanted || !port) return;
  window.postMessage('sm:libraryPort', '*', [port]);
  port = null;
}
ipcRenderer.on('library:port', (e) => {
  port = e.ports[0];
  passPort();
});
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data !== 'sm:wantPort') return;
  wanted = true;
  passPort();
});

// What goes through main: dialogs, menus, drag, windows. The library itself
// (lists, tags, sample bytes, change events) is on the worker port.
contextBridge.exposeInMainWorld('smMain', {
  addFolder: () => ipcRenderer.invoke('folder:add'),
  removeFolder: (id) => ipcRenderer.invoke('folder:remove', id),
  saveRecording: (bytes, name) => ipcRenderer.invoke('recording:save', bytes, name),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  // ids: sample id(s); main resolves files (crops included) and supplies the
  // (required, non-empty) drag icon.
  startDrag: (ids) => ipcRenderer.send('sample:startDrag', ids),
  prepareCrop: (id, start, end) => ipcRenderer.invoke('crop:prepare', id, start, end),
  clearCrop: (id) => ipcRenderer.invoke('crop:clear', id),
  saveCrop: (id) => ipcRenderer.invoke('crop:save', id),
  reveal: (id) => ipcRenderer.invoke('sample:reveal', id),
  sampleMenu: (ids) => ipcRenderer.send('sample:contextMenu', ids),
  dirMenu: (dir) => ipcRenderer.send('dir:contextMenu', dir),
  tagMenu: (name) => ipcRenderer.send('tag:contextMenu', name),
  kitsDir: () => ipcRenderer.invoke('kit:dir'),
  // Copies the samples (ids) into a kit; creates it when `create`.
  addToKit: (ids, kit, create) => ipcRenderer.invoke('kit:add', ids, kit, create),
  renameKit: (from, to) => ipcRenderer.invoke('kit:rename', from, to),
  startKitDrag: (dir) => ipcRenderer.send('kit:startDrag', dir),
  onNewKit: (cb) => subscribe('ui:newKit', cb),
  onRenameKit: (cb) => subscribe('ui:renameKit', cb),
  onKitDone: (cb) => subscribe('ui:kitDone', cb),
  onFlash: (cb) => subscribe('ui:flash', cb),
  onEditTags: (cb) => subscribe('ui:editTags', cb),
  onReveal: (cb) => subscribe('ui:reveal', cb),
  // Quick Search panel
  quickHide: () => ipcRenderer.send('quick:hide'),
  quickOpen: (id, path) => ipcRenderer.send('quick:open', id, path),
  openMainWindow: () => ipcRenderer.send('app:openMain'),
  onQuickShown: (cb) => subscribe('quick:shown', cb),
  onQuickHidden: (cb) => subscribe('quick:hidden', cb),
  onShowInSidebar: (cb) => subscribe('ui:showInSidebar', cb),
  foldersMenu: (at, state) => ipcRenderer.send('rail:foldersMenu', at, state),
  onFoldersCommand: (cb) => subscribe('ui:folders', cb),
  onUndo: (cb) => subscribe('ui:undo', cb),
});
