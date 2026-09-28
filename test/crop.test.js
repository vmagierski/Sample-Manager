const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-crops-'));
process.env.SM_CROP_DIR = dir;
const crop = require('../src/main/crop');

test('prune: dragged crops go a week after their last drag', () => {
  const day = 86400e3;
  const now = Date.now();
  const make = (name, age) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '');
    const t = new Date(now - age);
    fs.utimesSync(f, t, t);
  };
  make('old [0.00-1.00s].wav', (crop.KEEP_DAYS + 1) * day);
  make('fresh [0.00-1.00s].wav', day);
  make('notes.txt', 30 * day); // not a crop: left alone
  assert.strictEqual(crop.prune(now), 1);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['fresh [0.00-1.00s].wav', 'notes.txt']);
  fs.rmSync(dir, { recursive: true });
});
