# Sample Manager

Electron sample browser: watched folders → SQLite, rule-based auto-tagging, keyboard audition, native drag-to-DAW.

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

Re-run it after changing code. The build is ad-hoc signed (fine for your own machine; sharing it would need a Developer ID + notarization). Dev (`npm start`) and the installed app share one library.

The library DB lives in `~/Library/Application Support/sample-manager/library.db`.

## Keys

| Key | Action |
|---|---|
| ↑ / ↓, PgUp / PgDn, Home / End | Move (auditions when Auto-play is on); add Shift to extend the selection |
| Space | Play / pause |
| Enter or T | Edit tags of current row (comma-separated; Enter saves, Esc cancels) |
| / or ⌘F | Search (↑/↓ still move the list while typing) |
| ⌘A | Select all visible |
| Esc | Stop |
| I / O | Set crop start / end at the playhead |
| L | Loop on / off |
| ⌥-scroll on the waveform | Zoom in / out (horizontal scroll pans while zoomed) |
| ⌘[ / ⌘] (or mouse side buttons, or ‹ › in the header) | Back / forward to previous places — filters, selected sample and scroll position |
| ⌥⌘R | Show current sample in Finder |
| ⌘O / ⇧⌘R | Add folder / rescan library (reloads `tag-rules.json`) |

Click a folder (or any subfolder via ▸) in the sidebar to show only what is below it; ⇧/⌘-click to select several. Search looks inside the selected folders (the search box says so); "clear" deselects them, "collapse" closes the tree. The **⋯** next to Folders adds a folder or rescans; click the **Folders** / **Tags** headers to collapse either section. Each launch starts with only top-level folders open and no filters. The **Filter folders… / Filter tags…** boxes narrow the sidebar as you type. Whole-word matches rank first and the tree opens only down to the first matching folder (`snare` → EXS Factory › … › **02 Snares**); scattered-letter matches (`snr`, `vint snr`) are used only when nothing contains the word as typed. For folders each word may match a parent (`dr ks` → Drums › Kicks). Esc clears. Drag the sidebar's right edge to widen it (double-click to reset). Right-click a folder to hide it (struck through; right-click again to unhide).

**Crop:** drag across the player waveform to select part of a sample (drag the edges to resize, drag inside to move it, click outside or double-click to clear). Drag the top edge of the player to make the waveform taller. Playback stays inside the crop and **Loop** switches on (it's off by default; on without a crop it loops the whole sample), the row gets a ✂, and dragging the sample into your DAW drags just that part — a WAV saved to `~/Music/Sample Manager/Crops` (tagged *crop*). WAV/AIFF crops are cut losslessly in the original format; other formats become 24-bit WAV. Crops last for the session.

**R** or ⤮ Random plays a random sample from the whole library. **● Rec** records what plays; **⟲ Last 10s** saves the last 10 seconds you heard. Both save 24-bit WAVs to `~/Music/Sample Manager/Recordings` by default (created and added to the library on first launch).

Click selects and auditions; ⌘-click / Shift-click multi-select; click a row's tag cell to edit. Drag any row (or the whole selection) into your DAW. Right-click a sample for Show in Finder / Copy Path / Show in Sidebar / Edit Tags, or a sidebar folder for Show in Finder.

## Tagging

`tag-rules.json` is a list of `{tag, pattern}`; patterns are case-insensitive regexes matched against the path below the watched folder, so folder names count. Edit it (File → Edit Tag Rules…) then rescan. In dev that's the repo's file; the installed app uses its own copy at `~/Library/Application Support/sample-manager/tag-rules.json`, seeded from the repo's on first launch. Once you edit a sample's tags by hand, rescans leave that sample's tags alone, so removed auto tags stay removed.
