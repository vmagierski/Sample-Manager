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
  // paths: string | string[] — main supplies the (required, non-empty) drag icon.
  startDrag: (paths) => ipcRenderer.send('sample:startDrag', paths),
  reveal: (id) => ipcRenderer.invoke('sample:reveal', id),
  sampleMenu: (ids) => ipcRenderer.send('sample:contextMenu', ids),
  dirMenu: (dir) => ipcRenderer.send('dir:contextMenu', dir),
  tagMenu: (name) => ipcRenderer.send('tag:contextMenu', name),
  onEditTags: (cb) => subscribe('ui:editTags', cb),
  foldersMenu: (at, state) => ipcRenderer.send('rail:foldersMenu', at, state),
  onFoldersCommand: (cb) => subscribe('ui:folders', cb),
  onLibraryChanged: (cb) => subscribe('library:changed', cb),
  onTagsChanged: (cb) => subscribe('tags:changed', cb),
  onScanStatus: (cb) => subscribe('scan:status', cb),
});
