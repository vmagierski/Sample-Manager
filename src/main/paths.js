const path = require('path');

// Where the app keeps its files, by each platform's conventions — nothing
// here assumes a particular machine or user. Pure (no Electron), so it can be
// tested for every platform from any one.

// Per-user cache folder for things that can be rebuilt (converted CAFs,
// dragged crops):
//   macOS    ~/Library/Caches/Sample Manager
//   Windows  %LOCALAPPDATA%\Sample Manager\Cache
//   Linux    $XDG_CACHE_HOME/sample-manager (~/.cache/sample-manager)
function cacheDir({ platform = process.platform, env = process.env, home }) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Caches', 'Sample Manager');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Sample Manager', 'Cache');
  return path.posix.join(env.XDG_CACHE_HOME || path.posix.join(home, '.cache'), 'sample-manager');
}

// The app's own folder (recordings, kits) inside the user's Music folder, as
// the OS reports it — it may be redirected (OneDrive) or localized.
// getPath: Electron's app.getPath.
function appMusicDir(getPath) {
  let music;
  try {
    music = getPath('music');
  } catch {
    music = path.join(getPath('home'), 'Music'); // no Music folder known (some Linux setups)
  }
  return path.join(music, 'Sample Manager');
}

module.exports = { cacheDir, appMusicDir };
