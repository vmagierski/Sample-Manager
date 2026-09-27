const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const scanner = require('../src/main/scanner');

scanner.loadRules(path.join(__dirname, '..', 'tag-rules.json'));
const tags = (p) => scanner.tagsFor(p).sort();

test('drum one-shots', () => {
  assert.deepStrictEqual(tags('Kicks/Kick_01.wav'), ['kick']);
  assert.deepStrictEqual(tags('TR909 BD 03.wav'), ['kick']);
  assert.deepStrictEqual(tags('Snare Rim 2.aif'), ['snare']);
  assert.deepStrictEqual(tags('Hi-Hats/OH_04.wav'), ['hat']);
  assert.deepStrictEqual(tags('CH 1.wav'), ['hat']);
  assert.deepStrictEqual(tags('Clap_Big.wav'), ['clap']);
  assert.deepStrictEqual(tags('Low Tom.wav'), ['tom']);
  assert.deepStrictEqual(tags('Shaker 16th.wav'), ['perc']);
});

test('avoids substring false positives', () => {
  assert.deepStrictEqual(tags('That Thing.wav'), []);
  assert.deepStrictEqual(tags('Bottom End.wav'), []);
  assert.deepStrictEqual(tags('Choir Ahh.wav'), []);
  assert.deepStrictEqual(tags('Bass Drum 01.wav'), ['kick']); // not bass
});

test('melodic, fx, loops', () => {
  assert.deepStrictEqual(tags('Loops/Bass/Reese_Loop_128bpm.wav'), ['bass', 'loop']);
  assert.deepStrictEqual(tags('Synth Stab Cm.wav'), ['synth']);
  assert.deepStrictEqual(tags('Dark Pad A.wav'), ['pad']);
  assert.deepStrictEqual(tags('FX/Riser 8 bar.wav'), ['fx']);
  assert.deepStrictEqual(tags('Vox Chop 3.wav'), ['vocal']);
  assert.deepStrictEqual(tags('Atmospheres/Night Drone.wav'), ['ambient', 'atmosphere']);
  assert.deepStrictEqual(tags('One Shots/Sub Hit.wav'), ['bass', 'one-shot']);
  assert.deepStrictEqual(tags('Drum Loops/Top Loop 125 BPM.wav'), ['drums', 'loop']);
});

test('isAudio', () => {
  assert.ok(scanner.isAudio('/a/b.WAV'));
  assert.ok(scanner.isAudio('/a/b.aiff'));
  assert.ok(!scanner.isAudio('/a/._b.wav'));
  assert.ok(!scanner.isAudio('/a/b.asd'));
});

test('folder rules tag by absolute location', () => {
  const os = require('os');
  const fs = require('fs');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rules-')));
  const rulesFile = path.join(tmp, 'rules.json');
  fs.mkdirSync(path.join(tmp, 'Projects'));
  fs.writeFileSync(rulesFile, JSON.stringify([
    { tag: 'kick', pattern: 'kick' },
    { tag: 'my projects', folder: path.join(tmp, 'Projects') },
    { tag: 'home', folder: '~' },
  ]));
  scanner.loadRules(rulesFile);
  const home = fs.realpathSync(os.homedir());
  assert.deepStrictEqual(scanner.tagsFor('Song.logicx/Audio Files/Kick.wav', path.join(tmp, 'Projects/Song.logicx/Audio Files/Kick.wav')), ['kick', 'my projects']);
  assert.deepStrictEqual(scanner.tagsFor('x.wav', path.join(tmp, 'ProjectsOld/x.wav')), []); // prefix, not substring
  assert.deepStrictEqual(scanner.tagsFor('x.wav', path.join(home, 'x.wav')), ['home']);
  fs.rmSync(tmp, { recursive: true, force: true });
  scanner.loadRules(path.join(__dirname, '..', 'tag-rules.json'));
});

test('walk refuses an unreadable root instead of returning nothing', async () => {
  await assert.rejects(scanner.walk('/definitely/not/here'), { code: 'ENOENT' });
});
