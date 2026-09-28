// The library worker: a utilityProcess (see library.js) that owns the
// database, scanning, the folder watcher and audio conversion, so none of
// it can stall the main process (drag, menus, the hotkey).
//
// Main talks to it over the parent port; each window gets its own
// MessagePort straight to it, so list queries and sample bytes don't pass
// through main. Events (library:changed, tags:changed, scan:status) go
// straight to every window's port.
const Rpc = require('../shared/rpc');
const { createLibrary } = require('./library-service');

const parent = process.parentPort;
const ports = new Map(); // owner number -> MessagePortMain
let nextOwner = 0;

function broadcast(ch, ...args) {
  const msg = Rpc.event(ch, ...args);
  for (const port of ports.values()) port.postMessage(msg);
}

const toMain = (ch, ...args) => parent.postMessage(Rpc.event(ch, ...args));

const library = createLibrary({ broadcast, toMain });
const handleMain = Rpc.createServer(library.main);
const handleWindow = Rpc.createServer(library.windows);

function attachPort(port) {
  const owner = ++nextOwner;
  ports.set(owner, port);
  const ctx = { owner };
  const reply = (msg) => port.postMessage(msg);
  port.on('message', (e) => handleWindow(e.data, reply, ctx));
  port.on('close', () => ports.delete(owner));
  port.start();
}

parent.on('message', (e) => {
  if (e.data && e.data.t === 'port') {
    if (e.ports[0]) attachPort(e.ports[0]);
    return;
  }
  handleMain(e.data, (msg) => parent.postMessage(msg));
});
