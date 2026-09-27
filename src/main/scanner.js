const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIO_EXTS = new Set(['wav', 'wave', 'aif', 'aiff', 'aifc', 'mp3', 'flac', 'ogg', 'oga', 'm4a', 'caf']);

let rules = [];

// tag-rules.json: a list of rules, each one of:
//   { "tag": "kick", "pattern": "kick|..." }
//     case-insensitive regex matched against the sample's path relative to its
//     watched folder, so folder names ("Kicks/", "Loops/") count.
//   { "tag": "my projects", "folder": "~/Music/Logic" }
//     tags everything at or below that absolute folder (~ = home).
function loadRules(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.rules;
  const compiled = [];
  for (const { tag, pattern, folder } of list || []) {
    if (!tag || (!pattern && !folder)) continue;
    if (folder) {
      const abs = path.resolve(folder.replace(/^~(?=$|\/)/, os.homedir()));
      let real = abs;
      try {
        real = fs.realpathSync(abs); // library paths are canonical realpaths
      } catch {}
      compiled.push({ tag, folder: real });
      continue;
    }
    try {
      compiled.push({ tag, re: new RegExp(pattern, 'i') });
    } catch (err) {
      console.warn(`tag-rules: skipping "${tag}" — bad pattern: ${err.message}`);
    }
  }
  rules = compiled;
  return rules.length;
}

function tagsFor(relPath, absPath) {
  const subject = relPath.split(path.sep).join('/');
  const out = [];
  for (const { tag, re, folder } of rules) {
    const hit = folder
      ? absPath != null && (absPath === folder || absPath.startsWith(folder + path.sep))
      : re.test(subject);
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

const ruleTags = () => [...new Set(rules.map((r) => r.tag))];

module.exports = { loadRules, ruleTags, tagsFor, isAudio, walk, AUDIO_EXTS };
