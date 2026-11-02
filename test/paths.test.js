const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../src/main/paths');
const scanner = require('../src/main/scanner');

test('cache folder follows each platform, not one machine', () => {
  assert.strictEqual(paths.cacheDir({ platform: 'darwin', env: {}, home: '/Users/a' }), '/Users/a/Library/Caches/Sample Manager');
  assert.strictEqual(
    paths.cacheDir({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\Data\\Local' }, home: 'C:\\Users\\a' }),
    'D:\\Data\\Local\\Sample Manager\\Cache'
  );
  assert.strictEqual(paths.cacheDir({ platform: 'win32', env: {}, home: 'C:\\Users\\a' }), 'C:\\Users\\a\\AppData\\Local\\Sample Manager\\Cache');
  assert.strictEqual(paths.cacheDir({ platform: 'linux', env: { XDG_CACHE_HOME: '/c' }, home: '/home/a' }), '/c/sample-manager');
  assert.strictEqual(paths.cacheDir({ platform: 'linux', env: {}, home: '/home/a' }), '/home/a/.cache/sample-manager');
});

test("app folder is in the OS's Music folder, wherever that is", () => {
  const music = path.join(os.tmpdir(), 'Muziek');
  assert.strictEqual(paths.appMusicDir((n) => (n === 'music' ? music : '/h')), path.join(music, 'Sample Manager'));
  const noMusic = (n) => {
    if (n === 'music') throw new Error('Failed to get music path');
    return path.join(os.tmpdir(), 'home');
  };
  assert.strictEqual(paths.appMusicDir(noMusic), path.join(os.tmpdir(), 'home', 'Music', 'Sample Manager'));
});

test('tag rule folders: ~ and {appFolder} expand; without an app folder the rule matches nothing', () => {
  const app = path.join(os.tmpdir(), 'My Music', 'Sample Manager');
  assert.strictEqual(scanner.expandFolder('{appFolder}/Recordings', { appFolder: app }), path.join(app, 'Recordings'));
  assert.strictEqual(scanner.expandFolder('~/Samples', { home: os.tmpdir() }), path.join(os.tmpdir(), 'Samples'));
  assert.strictEqual(scanner.expandFolder('{appFolder}/Recordings', {}), null);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rules-'));
  const rulesFile = path.join(tmp, 'rules.json');
  const other = process.platform === 'darwin' ? 'win32' : 'darwin';
  fs.writeFileSync(rulesFile, JSON.stringify([
    { tag: 'recorded', folder: '{appFolder}/Recordings' },
    { tag: 'elsewhere', pattern: 'kick', platform: other },
    { tag: 'here', pattern: 'kick', platform: [process.platform] },
  ]));
  scanner.loadRules(rulesFile, { appFolder: tmp });
  assert.deepStrictEqual(scanner.ruleTags(), ['recorded', 'here']);
  assert.deepStrictEqual(scanner.tagsFor(path.join('Recordings', 'kick.wav'), path.join(fs.realpathSync(tmp), 'Recordings', 'kick.wav')), ['recorded', 'here']);

  scanner.loadRules(rulesFile); // no app folder: the tag is kept, matches nothing
  assert.deepStrictEqual(scanner.ruleTags(), ['recorded', 'here']);
  assert.deepStrictEqual(scanner.tagsFor('x.wav', path.join(tmp, 'Recordings', 'x.wav')), []);
  fs.rmSync(tmp, { recursive: true, force: true });
  scanner.loadRules(path.join(__dirname, '..', 'tag-rules.json'));
});
