const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('sm', {
  addFolder: () => ipcRenderer.invoke('folder:add'),
  removeFolder: (id) => ipcRenderer.invoke('folder:remove', id),
  listFolders: () => ipcRenderer.invoke('folders:list'),
  listDirs: () => ipcRenderer.invoke('folders:dirs'),
  listHidden: () => ipcRenderer.invoke('folders:hidden'),
  saveRecording: (bytes, name) => ipcRenderer.invoke('recording:save', bytes, name),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  listSamples: (filter) => ipcRenderer.invoke('samples:list', filter),
  listTags: () => ipcRenderer.invoke('tags:list'),
  updateTags: (id, tags) => ipcRenderer.invoke('samples:tag', id, tags),
  setDuration: (id, ms) => ipcRenderer.invoke('sample:duration', id, ms),
  readSample: (id) => ipcRenderer.invoke('sample:read', id),
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
  onLibraryChanged: (cb) => subscribe('library:changed', cb),
  onTagsChanged: (cb) => subscribe('tags:changed', cb),
  onScanStatus: (cb) => subscribe('scan:status', cb),
});
