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

## Quick Search (⌃⌥Space)

A Spotlight-style panel you can call up from anywhere, including over full-screen Logic:
type to search the whole library (every word must match; file-name matches first). `#tag`
filters by tag — a prefix like `#ki` is enough, and Space / Tab / ↵ turns it into a chip
(Backspace in an empty box removes the last one), **↑/↓** to audition, **⇧↵** play/stop, **drag** a result straight
into Logic, **↵** to open it in the main window, **⌘↵** to show it in Finder, **esc** to close.

Sample Manager is a menu-bar app: with its window closed it lives only in the menu bar
(waveform icon — no ⌘Tab / Dock entry) so the hotkey and folder watching keep working; while
the window is open it's a normal app. **⌘Q** closes the window back to the menu bar; **⌥⌘Q** or
the menu-bar icon → *Quit* quits completely. Launching it (Spotlight, Finder) opens the window;
*Open at Login* (in the icon's menu) starts it quietly in the menu bar. To change the hotkey, put e.g.
`{ "quickSearchHotkey": "Control+Alt+Space" }` in
`~/Library/Application Support/sample-manager/settings.json` and restart.

## Keys

| Key | Action |
|---|---|
| ↑ / ↓, PgUp / PgDn, Home / End | Move (auditions when Auto-play is on); add Shift to extend the selection |
| Space | Play / pause |
| Enter or T | Edit tags of current row (comma-separated; Enter saves, Esc cancels) |
| / or ⌘F | Search (↑/↓ still move the list while typing) |
| Enter (in search) | Keep the search as a chip and start another (`#tag` adds a tag chip) |
| Backspace (empty search) | Remove the last chip |
| ⌘A | Select all visible |
| Esc | Clear the crop region (keeps playing); with no region, stop |
| I / O | Set crop start / end at the playhead |
| L | Loop on / off |
| ⌥-scroll on the waveform | Zoom in / out (horizontal scroll pans while zoomed) |
| ⌘[ / ⌘] (or mouse side buttons, or ‹ › in the header) | Back / forward to previous places — filters, selected sample and scroll position |
| ⌥⌘R | Show current sample in Finder |
| ⌘O / ⇧⌘R | Add folder / rescan library (reloads `tag-rules.json`) |

Active filters are always visible: tags and kept searches show as chips in the search box (× removes one), and the Folders / Tags headers show an orange label for the current folder / tag filter even when the section is collapsed (× clears it). Click a folder (or any subfolder via ▸) in the sidebar to show only what is below it; ⇧/⌘-click to select several. Search looks inside the selected folders (the search box says so); the orange label × deselects them; ⋯ → Collapse All closes the tree. The **⋯** next to Folders adds a folder or rescans; click the **Folders** / **Tags** headers to collapse either section. Each launch starts with only top-level folders open and no filters. The **Filter folders… / Filter tags…** boxes narrow the sidebar as you type. Whole-word matches rank first and the tree opens only down to the first matching folder (`snare` → EXS Factory › … › **02 Snares**); scattered-letter matches (`snr`, `vint snr`) are used only when nothing contains the word as typed. For folders each word may match a parent (`dr ks` → Drums › Kicks). Esc clears. Drag the sidebar's right edge to widen it (double-click to reset). Right-click a folder to hide it (struck through; right-click again to unhide).

**Crop:** drag across the player waveform to select part of a sample (drag the edges to resize, drag inside to move it, click outside or double-click to clear). Drag the top edge of the player to make the waveform taller. A **⠿ Drag crop · Save…** handle floats on the region: drag it to drop just the crop into Logic, Finder or the Desktop (the region itself doesn't move), or Save… it as a WAV (defaults to the Desktop). Playback stays inside the crop and **Loop** switches on (it's off by default; on without a crop it loops the whole sample), the row gets a ✂, and dragging the sample into your DAW drags just that part — a WAV saved to `~/Music/Sample Manager/Crops` (tagged *crop*). WAV/AIFF crops are cut losslessly in the original format; other formats become 24-bit WAV. Crops last for the session.

**R** or ⤮ Random plays a random sample from whatever the current filters show (search, tags, folders) — or from the whole library when nothing is filtered. **● Rec** records what plays; **⟲ Last 10s** saves the last 10 seconds you heard. Both save 24-bit WAVs to `~/Music/Sample Manager/Recordings` by default (created and added to the library on first launch).

Click selects and auditions; ⌘-click / Shift-click multi-select; click a row's tag cell to edit. Drag any row (or the whole selection) into your DAW. Right-click a sample for Show in Finder / Copy Path / Show in Sidebar / Edit Tags, or a sidebar folder for Show in Finder.

## Tagging

`tag-rules.json` is a list of `{tag, pattern}`; patterns are case-insensitive regexes matched against the path below the watched folder, so folder names count. Edit it (File → Edit Tag Rules…) then rescan. In dev that's the repo's file; the installed app uses its own copy at `~/Library/Application Support/sample-manager/tag-rules.json`, seeded from the repo's on first launch. Once you edit a sample's tags by hand, rescans leave that sample's tags alone, so removed auto tags stay removed.
