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
    listTags: call('listTags'),
    listDirs: call('listDirs'),
    listFolders: call('listFolders'),
    listHidden: call('listHidden'),
    updateTags: call('updateTags'),
    setDuration: call('setDuration'),
    // Resolves null if a newer readSample from this page superseded it.
    readSample: call('readSample'),
    onLibraryChanged: on('library:changed'),
    onTagsChanged: on('tags:changed'),
    onScanStatus: on('scan:status'),
  };
})();
