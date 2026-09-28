// Timing checks against a large generated library (see make-bench-library.js).
// A measurement tool, not a test: misses are reported, never fail the run.
//
//   npm run bench [-- --dir D] [--json] [--runs N] [--skip-large] [--skip-scan]
//
// Everything else (--samples, --tree-files, --large-min, --force) is passed to
// the library generator, which only builds what's missing.

const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { make, parseArgs } = require('./make-bench-library');

// --- the app APIs we time (kept in one place, to adapt as they change) -------

const app = {
  db: () => require(path.join(REPO, 'src/main/db')),
  scanner: () => require(path.join(REPO, 'src/main/scanner')),
  audio: () => require(path.join(REPO, 'src/main/audio')),
  listSamples: (filter) => app.db().listSamples(filter),
  listDirs: () => app.db().listDirs(),
  listTags: () => app.db().listTags(),
  walk: (root) => app.scanner().walk(root),
  syncFolder: (folderId, root, files) =>
    app.db().syncFolder(folderId, files, (p) => app.scanner().tagsFor(path.relative(root, p), p)),
  readPlayable: (file) => app.audio().readPlayable(file),
  cropToWav: (file, start, end) => app.audio().cropToWav(file, start, end),
};

// A query as the main window runs it: rank on, no limit.
const view = (f = {}) => ({ search: '', tags: [], untagged: false, dirs: [], rank: true, ...f });

// --- measuring ---------------------------------------------------------------

const now = () => Number(process.hrtime.bigint()) / 1e6;

async function timeIt(fn, runs) {
  await fn(); // warm-up (prepared statements, page cache)
  const ms = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const t0 = now();
    out = await fn();
    ms.push(now() - t0);
  }
  ms.sort((a, b) => a - b);
  return { median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1], out };
}

const results = [];
function record(group, name, value, target, unit = 'ms', note = '') {
  const pass = target == null ? null : value <= target;
  results.push({ group, name, value: Math.round(value * 10) / 10, unit, target, pass, note });
}

// --- 750k-sample queries -------------------------------------------------------

async function benchQueries(opts) {
  const db = app.db();
  db.open(path.join(opts.dir, 'library.db'));
  const folders = db.listFolders();
  const user = folders.find((f) => f.label === 'User Library') || folders[0];
  const factory = folders.find((f) => f.label === 'Logic Factory') || folders[0];
  // A pack folder: the first directory level below the User Library root.
  const dirs = app.listDirs();
  const packOf = (d) => d.dir.slice(0, d.dir.indexOf('/', user.path.length + 1));
  const pack = packOf(dirs.find((d) => d.folderId === user.id && d.dir.length > user.path.length + 1));
  const n = db.listSamples({ limit: 1 }).total;
  const label = `@${Math.round(n / 1000)}k`;

  // Main-list queries: SQL time, then the structured-clone cost of sending the
  // rows to the renderer (v8.serialize is what IPC uses).
  const cases = [
    ['list: unfiltered', view()],
    ['list: watched folder', view({ dirs: [user.path] })],
    ['list: pack folder', view({ dirs: [pack] })],
    ['list: tag #kick', view({ tags: ['kick'] })],
    ['list: tags #kick #loop', view({ tags: ['kick', 'loop'] })],
    ['search: "kick"', view({ search: 'kick' })],
    ['search: "dark pad"', view({ search: 'dark pad' })],
    ['search: "vinyl drum loop"', view({ search: 'vinyl drum loop' })],
    ['search: "zzqx" (no hits)', view({ search: 'zzqx' })],
    ['search: "kick" in folder', view({ search: 'kick', dirs: [user.path] })],
  ];
  for (const [name, filter] of cases) {
    const t = await timeIt(() => app.listSamples(filter), opts.runs);
    const rows = t.out.rows;
    const c = await timeIt(() => v8.serialize(rows), Math.min(opts.runs, 3));
    record(`queries ${label}`, name, t.median + c.median, 50, 'ms',
      `sql ${t.median.toFixed(0)} + clone ${c.median.toFixed(0)}, ${rows.length} rows, ${mb(v8.serialize(rows).length)}`);
  }

  let t = await timeIt(() => app.listDirs(), opts.runs);
  record(`queries ${label}`, 'listDirs', t.median, 50, 'ms', `${t.out.length} dirs`);
  t = await timeIt(() => app.listTags(), opts.runs);
  record(`queries ${label}`, 'listTags', t.median, 50, 'ms', `${t.out.tags.length} tags`);

  // One hidden folder: a pack in the Logic Factory root.
  const factoryDir = dirs.find((d) => d.folderId === factory.id && d.dir.length > factory.path.length + 1).dir;
  const hidden = factoryDir.slice(0, factoryDir.indexOf('/', factory.path.length + 1));
  db.hideDir(hidden);
  try {
    t = await timeIt(() => app.listTags(), opts.runs);
    record(`queries ${label}`, 'listTags, 1 hidden folder', t.median, 50);
    t = await timeIt(() => app.listSamples(view()), opts.runs);
    record(`queries ${label}`, 'list: unfiltered, 1 hidden folder', t.median, 50, 'ms', `sql only, ${t.out.rows.length} rows`);
    t = await timeIt(() => app.listSamples(view({ search: 'kick' })), opts.runs);
    record(`queries ${label}`, 'search: "kick", 1 hidden folder', t.median, 50, 'ms', `sql only`);
  } finally {
    db.unhideDir(hidden);
  }
  db.close();
}

// --- scanning a real tree --------------------------------------------------------

async function benchScan(opts) {
  const db = app.db();
  const root = fs.realpathSync(path.join(opts.dir, 'tree'));
  const file = path.join(opts.dir, 'scan.db');
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
  db.open(file);
  app.scanner().loadRules(path.join(REPO, 'tag-rules.json'));
  const folder = db.addFolder(root, 'tree');
  const pass = async (name, target) => {
    const t0 = now();
    const files = await app.walk(root);
    const t1 = now();
    app.syncFolder(folder.id, root, files);
    const t2 = now();
    const k = `@${(files.length / 1000).toFixed(0)}k files`;
    record(`scan ${k}`, `${name}: walk (async)`, t1 - t0, null);
    record(`scan ${k}`, `${name}: syncFolder (blocks main)`, t2 - t1, target);
  };
  await pass('first scan', null);
  await pass('rescan, nothing changed', 100);
  db.close();
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
}

// --- large files: each op in its own process, for a clean peak RSS ----------------

function child(op, file, at) {
  const out = execFileSync(process.execPath, [__filename, '--child', op, file, String(at)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

async function runChild(op, file, at) {
  const base = process.resourceUsage().maxRSS * 1024;
  const t0 = now();
  let bytes = 0;
  if (op === 'read') bytes = (await app.readPlayable(file)).length;
  else if (op === 'crop') {
    bytes = (await app.cropToWav(file, +at, +at + 1)).length;
  }
  const ms = now() - t0;
  process.stdout.write(JSON.stringify({ ms, bytes, peakRss: process.resourceUsage().maxRSS * 1024, baseRss: base }) + '\n');
}

// Seconds, from the file header (macOS afinfo).
function duration(file) {
  const out = execFileSync('/usr/bin/afinfo', [file], { encoding: 'utf8' });
  return +(/estimated duration: ([\d.]+)/.exec(out) || [0, 0])[1];
}

function benchLarge(opts) {
  const dir = path.join(opts.dir, 'large');
  for (const name of ['long.wav', 'long.aif', 'long-alac.caf', 'medium-aac.caf']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const g = `large files`;
    const size = mb(fs.statSync(file).size);
    const mid = duration(file) / 2; // crop 1 s from the middle
    for (const [op, label] of [['read', 'readPlayable'], ['crop', 'cropToWav 1 s']]) {
      let r;
      try {
        r = child(op, file, mid);
      } catch (err) {
        record(g, `${label}: ${name} (${size})`, NaN, 150, 'ms', `FAILED: ${String(err.stderr || err.message).split('\n')[0]}`);
        continue;
      }
      record(g, `${label}: ${name} (${size})`, r.ms, 150, 'ms', `→ ${mb(r.bytes)}`);
      record(g, `${label}: ${name} peak RSS`, r.peakRss / 1048576, 1024, 'MB');
    }
  }
}

// --- output ------------------------------------------------------------------------

const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(0)} MB` : `${(n / 1024).toFixed(0)} KB`);

function printTable() {
  let group = null;
  const w = Math.max(...results.map((r) => r.name.length)) + 2;
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      process.stdout.write(`\n${group}\n`);
    }
    const val = Number.isNaN(r.value) ? '—' : `${r.value} ${r.unit}`;
    const target = r.target == null ? '' : `< ${r.target} ${r.unit}`;
    const mark = r.pass == null ? '    ' : r.pass ? 'ok  ' : 'MISS';
    process.stdout.write(`  ${mark} ${r.name.padEnd(w)}${val.padStart(11)}  ${target.padEnd(11)} ${r.note}\n`);
  }
  const misses = results.filter((r) => r.pass === false).length;
  process.stdout.write(`\n${misses} of ${results.filter((r) => r.pass != null).length} targets missed\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child') return runChild(argv[1], argv[2], argv[3]);
  const opts = parseArgs(argv);
  opts.json = argv.includes('--json');
  const runsAt = argv.indexOf('--runs');
  opts.runs = runsAt >= 0 ? +argv[runsAt + 1] : 5;
  make(opts);
  await benchQueries(opts);
  if (!argv.includes('--skip-scan')) await benchScan(opts);
  if (!argv.includes('--skip-large')) benchLarge(opts);
  if (opts.json) process.stdout.write(JSON.stringify({ dir: opts.dir, results }, null, 2) + '\n');
  else printTable();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
