// Names of things that differ by platform, for menus and messages.
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

module.exports = {
  showInFileManager: isMac ? 'Show in Finder' : isWin ? 'Show in File Explorer' : 'Show in File Manager',
  trash: isWin ? 'Recycle Bin' : 'Trash',
  // Where the app lives with its window closed.
  tray: isMac ? 'Menu Bar' : isWin ? 'System Tray' : 'Tray',
};
