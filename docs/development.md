# Development

Electron app, vanilla JS, no bundler. The main process indexes watched folders into SQLite (better-sqlite3), watches them with chokidar and tags samples by `tag-rules.json`; the renderer is the browser UI and the Quick Search panel.

```sh
npm install        # also rebuilds better-sqlite3 for Electron
npm start
npm test           # unit tests (run under Electron's Node)
SM_USER_DATA=/tmp/sm-test npm start   # use a throwaway library
```

## Installing as a Mac app

```sh
npm run install-app   # builds dist/mac-arm64/Sample Manager.app and copies it to /Applications
```

Quit the app first (⌥⌘Q — ⌘Q only closes the window to the menu bar). Re-run it after changing code. The build is ad-hoc signed: fine for your own machine; sharing it would need a Developer ID and notarization. Dev (`npm start`) and the installed app share one library.

## Where things live

| What | Where |
|---|---|
| Library database | `~/Library/Application Support/sample-manager/library.db` |
| Tag rules (installed app) | `~/Library/Application Support/sample-manager/tag-rules.json` — seeded from the repo's on first launch; in dev the repo's file is used |
| Settings | `~/Library/Application Support/sample-manager/settings.json` (`quickSearchHotkey`) |
| Recordings | `~/Music/Sample Manager/Recordings` |
| Dragged crops | `~/Library/Caches/Sample Manager/Crops` (deleted a week after their last drag) |
| Converted CAFs | `~/Library/Caches/Sample Manager/Converted` (WAV copies for playback and crops; capped at 2 GB, least recently used go first) |

## Layout

| Path | |
|---|---|
| `src/main/index.js` | App lifecycle, menus, IPC, folder adding / scanning |
| `src/main/db.js` | SQLite schema and queries (search, ranking, tags, hidden folders) |
| `src/main/scanner.js` | Folder walk and rule-based tagging |
| `src/main/watcher.js` | chokidar watching, with rename detection |
| `src/main/drag.js` | Native drag-out (`webContents.startDrag`) |
| `src/main/crop.js` | Rendering, dragging and pruning crops |
| `src/main/audio.js` | AIFF/CAF decoding, WAV slicing |
| `src/main/convcache.js` | On-disk cache of CAF conversions |
| `src/main/latest.js` | One sample load per window at a time, newest wins |
| `src/main/quick.js` | Quick Search panel, menu-bar icon, global hotkey |
| `src/renderer/` | Main window (`index.html`, `app.js`) and Quick Search (`quick.*`); `buffer-cache.js` (decoded-audio cache and loader) is shared by both |
| `test/` | Unit tests |

## Testing alongside the installed app

Environment variables for a test copy:

- `SM_USER_DATA` — a separate library / settings folder. A test copy with this set doesn't register the global hotkey, so it can't take ⌃⌥Space from the installed app.
- `SM_CROP_DIR` — where dragged crops go.
- `SM_CACHE_DIR` — where converted CAFs are cached.
- `SM_NO_HOTKEY` — skip the hotkey; `SM_HOTKEY` — register it even with `SM_USER_DATA`.
- `SM_START_HIDDEN` — start in the menu bar only, as a login launch does.
