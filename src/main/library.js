const path = require('path');
const { utilityProcess, MessageChannelMain } = require('electron');
const Rpc = require('../shared/rpc');

// Main's side of the library worker (library-worker.js): starts it, asks it
// to do things (call), hears its events (on), hands every window a port
// straight to it (connectWindow), and restarts it if it dies — with fresh
// ports for the windows, which then reload what they show.

const WORKER = path.join(__dirname, 'library-worker.js');

// Wait before restarting a worker that died: doubling from 250 ms up to 30 s
// while it keeps dying; back to the start once one has run for a minute.
const RESTART_MIN_MS = 250;
const RESTART_MAX_MS = 30e3;
const STABLE_MS = 60e3;

const restartDelay = (failures) => Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.max(0, failures - 1));

const client = Rpc.createClient();
const windows = new Set(); // webContents with a port to the worker
let child = null;
let config = null;
let quitting = false;
let failures = 0;
let restartTimer = null;

function start() {
  const proc = utilityProcess.fork(WORKER, [], { serviceName: 'Sample Manager Library', stdio: 'inherit' });
  child = proc;
  const startedAt = Date.now();
  proc.on('message', (msg) => client.receive(msg));
  proc.once('exit', (code) => {
    if (child !== proc) return;
    child = null;
    client.disconnect();
    // Main's calls aren't all safe to repeat (adding a folder…): fail them.
    client.fail('the library worker stopped');
    if (quitting) return;
    failures = Date.now() - startedAt > STABLE_MS ? 1 : failures + 1;
    const wait = restartDelay(failures);
    console.error(`library worker exited (code ${code}); restarting in ${wait} ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!quitting) start().catch((err) => console.error('library worker restart failed:', err));
    }, wait);
  });
  client.connect((msg) => proc.postMessage(msg));
  const ready = client.call('init', config);
  for (const wc of windows) handPort(wc);
  return ready;
}

// Start the worker; resolves once the database is open.
function init(cfg) {
  config = cfg;
  return start();
}

// A new channel for this window: one end to the worker, one to the page
// (the preload passes it on — see library.js in the renderer).
function handPort(wc) {
  if (!child || wc.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ t: 'port' }, [port1]);
  wc.postMessage('library:port', null, [port2]);
}

// Give this window a port whenever its page loads (first load, reload,
// recovery from a crash) and again whenever the worker restarts.
function connectWindow(wc) {
  windows.add(wc);
  wc.on('dom-ready', () => handPort(wc));
  wc.once('destroyed', () => windows.delete(wc));
}

const call = (method, ...args) => client.call(method, ...args);
const on = (ch, cb) => client.on(ch, cb);

// Quitting: the worker closes its watchers and database; it isn't restarted.
function shutdown() {
  quitting = true;
  clearTimeout(restartTimer);
  if (child) call('shutdown').catch(() => {});
}

const pid = () => (child ? child.pid : null);

module.exports = { init, call, on, connectWindow, shutdown, pid, restartDelay };
