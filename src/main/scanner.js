const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIO_EXTS = new Set(['wav', 'wave', 'aif', 'aiff', 'aifc', 'mp3', 'flac', 'ogg', 'oga', 'm4a', 'caf']);

let rules = [];
let hash = '';

// tag-rules.json: a list of rules, each one of:
//   { "tag": "kick", "pattern": "kick|..." }
//     case-insensitive regex matched against the sample's path relative to its
//     watched folder, so folder names ("Kicks/", "Loops/") count.
//   { "tag": "recorded", "folder": "{appFolder}/Recordings" }
//     tags everything at or below that absolute folder. "~" is your home
//     folder and "{appFolder}" the app's own folder (opts.appFolder: Sample
//     Manager in your Music folder); "/" works as a separator everywhere.
// Any rule can have "platform": "darwin" (or a list, e.g. ["darwin",
// "win32"]) to apply only there.
function expandFolder(folder, { appFolder, home = os.homedir() } = {}) {
  let f = folder.replace(/^~(?=$|[\\/])/, home);
  if (f.startsWith('{appFolder}')) {
    if (!appFolder) return null; // nothing to expand it to: the rule matches nothing
    f = appFolder + f.slice('{appFolder}'.length);
  }
  return path.resolve(f);
}

// Library paths are canonical realpaths, so a rule's folder must be too —
// even before it exists (Recordings on a first launch): the real path of its
// nearest existing ancestor, plus the rest.
function realish(abs) {
  let dir = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return abs;
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
}

function loadRules(file, opts = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.rules;
  const compiled = [];
  for (const { tag, pattern, folder, platform } of list || []) {
    if (!tag || (!pattern && !folder)) continue;
    if (platform && ![].concat(platform).includes(process.platform)) continue;
    if (folder) {
      const abs = expandFolder(folder, opts);
      if (!abs) {
        compiled.push({ tag, folder: null }); // its tag still shows, with no samples
        continue;
      }
      compiled.push({ tag, folder: realish(abs) });
      continue;
    }
    try {
      compiled.push({ tag, re: new RegExp(pattern, 'i') });
    } catch (err) {
      console.warn(`tag-rules: skipping "${tag}" — bad pattern: ${err.message}`);
    }
  }
  rules = compiled;
  hash = crypto
    .createHash('sha1')
    .update(JSON.stringify(rules.map(({ tag, re, folder }) => [tag, re ? re.source : null, folder || null])))
    .digest('hex');
  return rules.length;
}

function tagsFor(relPath, absPath) {
  const subject = relPath.split(path.sep).join('/');
  const out = [];
  for (const { tag, re, folder } of rules) {
    const hit = re
      ? re.test(subject)
      : folder != null && absPath != null && (absPath === folder || absPath.startsWith(folder + path.sep));
    if (hit && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function isAudio(p) {
  const base = path.basename(p);
  if (base.startsWith('.')) return false; // includes macOS ._AppleDouble files
  return AUDIO_EXTS.has(path.extname(base).slice(1).toLowerCase());
}

// Recursive walk. Skips dotfiles/dot-dirs and doesn't follow directory
// symlinks (avoids loops). Returns [{ path, size, mtime }]; throws if the root
// itself can't be read.
async function walk(root) {
  const out = [];
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // An unreadable root (macOS privacy protection, unplugged drive) must not
      // look like an empty folder — that would wipe its samples and tags.
      if (dir === root) throw err;
      console.warn(`scan: can't read ${dir}: ${err.message}`);
      continue;
    }
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) dirs.push(full);
      else if ((e.isFile() || e.isSymbolicLink()) && isAudio(full)) files.push(full);
    }
    const stats = await Promise.all(files.map((f) => fs.promises.stat(f).catch(() => null)));
    stats.forEach((st, i) => {
      if (st && st.isFile()) out.push({ path: files[i], size: st.size, mtime: Math.round(st.mtimeMs) });
    });
  }
  return out;
}

// Changes whenever the loaded rules could tag anything differently. Null
// until tag-rules.json has loaded once, so a broken file doesn't untag
// the whole library.
const rulesHash = () => hash || null;

const ruleTags = () => [...new Set(rules.map((r) => r.tag))];

module.exports = { loadRules, expandFolder, rulesHash, ruleTags, tagsFor, isAudio, walk, AUDIO_EXTS };
