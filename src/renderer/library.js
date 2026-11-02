'use strict';

// window.sm: everything the page asks for. Dialogs, menus and drag go through
// main (window.smMain, from the preload); the library itself — lists, tags,
// sample bytes, change events — goes straight to the library worker over a
// MessagePort, without a hop through main.
//
// The port arrives from the preload on every page load and again if the
// worker restarts. Calls made meanwhile wait for it, and calls still
// unanswered when a new port arrives are sent again (they're all safe to
// repeat). A new worker numbers its changes from scratch, so the page is
// told to reload everything.
(() => {
  const client = Rpc.createClient();
  let port = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data !== 'sm:libraryPort' || !e.ports[0]) return;
    const reconnect = !!port;
    if (port) port.close();
    port = e.ports[0];
    port.onmessage = (m) => client.receive(m.data);
    client.connect((msg) => port.postMessage(msg));
    if (reconnect) client.emit('library:changed', { all: true, dirs: [], from: 0, to: Infinity });
  });
  window.postMessage('sm:wantPort', '*');

  const call = (method) => (...args) => client.call(method, ...args);
  const on = (ch) => (cb) => client.on(ch, cb);

  window.sm = {
    ...window.smMain,
    listSamples: call('listSamples'),
    listIds: call('listIds'),
    getRows: call('getRows'),
    listTags: call('listTags'),
    listDirs: call('listDirs'),
    listFolders: call('listFolders'),
    listHidden: call('listHidden'),
    listKits: call('listKits'),
    suggestKitName: call('suggestKitName'),
    updateTags: call('updateTags'),
    setDuration: call('setDuration'),
    // Resolves null if a newer readSample from this page superseded it.
    readSample: call('readSample'),
    onLibraryChanged: on('library:changed'),
    onTagsChanged: on('tags:changed'),
    onScanStatus: on('scan:status'),
  };
})();

// Labels are written the macOS way (⌘O, ⇧-click, Finder, Logic). Elsewhere,
// window.sm.keys rewrites them — ⌘O → Ctrl+O, ⇧-click → Shift-click, Finder →
// File Explorer — and the page's static titles and key hints are rewritten
// once here. (The shortcuts themselves accept Ctrl wherever they take ⌘.)
(() => {
  const platform = window.sm.platform || 'darwin';
  if (platform === 'darwin') {
    window.sm.keys = (s) => s;
    return;
  }
  const mods = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
  const fileManager = platform === 'win32' ? 'File Explorer' : 'file manager';
  window.sm.keys = (s) =>
    String(s)
      .replace(/([⌘⌃⌥⇧]+)(-?)/g, (_m, keys, dash) => [...new Set([...keys].map((k) => mods[k]))].join('+') + (dash || '+'))
      .replace(/\bFinder\b/g, fileManager)
      .replace(/\bLogic\b/g, 'your DAW');
  for (const e of document.querySelectorAll('[title]')) e.title = window.sm.keys(e.title);
  for (const e of document.querySelectorAll('kbd, #hints span')) {
    for (const n of e.childNodes) if (n.nodeType === Node.TEXT_NODE) n.textContent = window.sm.keys(n.textContent);
  }
})();
