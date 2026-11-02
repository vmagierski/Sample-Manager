// Runs Electron's bundled Node (ELECTRON_RUN_AS_NODE=1) with these arguments,
// the same on every platform — `VAR=1 cmd` in an npm script doesn't work in
// Windows' cmd.exe. Used by npm test / bench / bench:make, so native modules
// (better-sqlite3) load against the ABI they were rebuilt for.
const { spawnSync } = require('child_process');
const electron = require('electron'); // the binary's path, from plain Node

const r = spawnSync(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
