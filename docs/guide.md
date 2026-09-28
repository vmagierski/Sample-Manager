# User guide

- [Library and folders](#library-and-folders)
- [Quick Search (⌃⌥Space)](#quick-search-space)
- [Searching and filtering](#searching-and-filtering)
- [Auditioning and dragging](#auditioning-and-dragging)
- [Crops](#crops)
- [Random, Rec and Last 10s](#random-rec-and-last-10s)
- [Tags](#tags)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Library and folders

Add sample folders with **⌘O** (or **⋯** next to Folders). Sample Manager indexes everything below them and watches for changes: new, moved, renamed and deleted files show up by themselves. Adding a folder that's already in the library (or inside one) just rescans it and shows it in the sidebar. **⇧⌘R** rescans everything.

Formats: WAV, AIFF, CAF (Apple Loops), MP3, M4A, FLAC and Ogg.

The sidebar shows your folders as a tree. Click a folder (or a subfolder via ▸) to show only what's below it; ⇧/⌘-click to select several. **⋯ → Collapse All** closes the tree. Right-click a folder to hide it (struck through, and its samples and subfolders are left out everywhere; right-click again to unhide) or show it in Finder. Drag the sidebar's right edge to widen it (double-click to reset); click the **Folders** / **Tags** headers to collapse either section. Each launch starts with only top-level folders open and no filters.

## Quick Search (⌃⌥Space)

A Spotlight-style panel you can open from anywhere, including over full-screen Logic. Type to search the whole library; `#tag` narrows by tag (`#ki` is enough; Space / Tab / Enter turns it into a chip). **↑/↓** audition, **⇧↵** play / stop, **drag** a result straight into Logic, **↵** open it in the main window, **⌘↵** show it in Finder, **esc** close.

Sample Manager lives in the menu bar (waveform icon) so the hotkey and folder watching keep working when its window is closed. **⌘Q** closes the window to the menu bar; **⌥⌘Q** or the menu-bar icon → *Quit* quits completely. *Open at Login* in the icon's menu starts it quietly in the menu bar.

To change the hotkey, put e.g. `{ "quickSearchHotkey": "Control+Alt+Space" }` in `~/Library/Application Support/sample-manager/settings.json` and restart.

## Searching and filtering

Type in the search box (**/** or **⌘F**) — every word must match the file name, its folders or its tags. Results are ranked: file-name matches first, then an exact name (`white noise` → *white noise.wav*), then the words as a phrase, then shorter names. With nothing typed the list is alphabetical.

Every active filter shows as a chip in the search box:

- **Folders** — orange. Type `/` and part of a folder name to pick one from a list of matches (↑↓ to choose, Enter or Tab to add, Esc to cancel). Put parent words first: `/dr kick` finds Drums › Kicks. Several folder chips search in any of them. Click a folder chip to find it in the sidebar.
- **Tags** — in the tag's colour. `#` works the same way: `#dr` → *drums*. Several tag chips must all match.
- **Searches** — press **Enter** to keep what you typed as a chip and start another.

× removes a chip; **Backspace** in an empty box removes the last one. The Folders / Tags headers also show the active folder and tag filters, even when collapsed.

The **Filter folders… / Filter tags…** boxes narrow the sidebar as you type. Whole-word matches rank first and the tree opens down to the first match (`snare` → EXS Factory › … › **02 Snares**); scattered-letter matches (`snr`) are used only when nothing contains the word as typed. Each word may match a parent folder (`dr ks` shows Kicks inside Drums). Esc clears.

**⌘[ / ⌘]** (or the mouse side buttons, or ‹ › in the header) go back and forward through places you've been — filters, selected sample and scroll position.

## Auditioning and dragging

Move with ↑/↓ and each sample plays as you land on it (turn off **Auto-play** to stop that). **Space** plays / pauses. Click selects and plays; ⌘-click / ⇧-click select several.

**Drag** any row — or the whole selection — into Logic or any other app. Right-click a sample for Show in Finder, Copy Path, Show in Sidebar or Edit Tags.

The player shows the waveform: click to jump, **⌥-scroll** to zoom (horizontal scroll pans while zoomed), drag the player's top edge to make it taller. **L** (or the loop button) loops; it stays on as you move through samples until you turn it off, and starts off at each launch. The volume slider is in dB.

## Crops

Drag across the waveform to select part of a sample. Drag the edges to resize, drag inside to move it, **I** / **O** set the start / end at the playhead, and **Esc**, a click outside or a double-click clears it (playback carries on). Playback stays inside the crop and Loop switches on; the row gets a ✂.

Dragging the sample now drags just the crop. The **⠿ Drag crop · Save…** handle on the region does the same, or **Save…** writes the crop as a WAV wherever you like. WAV and AIFF crops are cut losslessly in the original format; other formats become 24-bit WAV.

Dragged crops aren't kept: they're written to `~/Library/Caches/Sample Manager/Crops` and deleted a week after their last drag. So Logic keeps its own copy, turn on **File › Project Settings › Assets › Copy audio files into project** (and save it in your project template) — saving the project then copies the crop in. Use **Save…** to keep a crop for good.

## Random, Rec and Last 10s

**R** or **⤮ Random** plays a random sample from whatever the current filters show, or from the whole library when nothing is filtered. **⇧R** (or ⇧-click ⤮ Random) also drops a crop region at a random spot in it and loops it — as long as the last crop you made, or 1 second before you've made one. Drag it into Logic like any crop.

**● Rec** records whatever Sample Manager plays — audition a few samples, play with a crop loop — and **⟲ Last 10s** saves the last ten seconds you heard, after the fact. Both save 24-bit WAVs to `~/Music/Sample Manager/Recordings`, which is in your library, and select the new recording so you can play or drag it straight away.

## Tags

Samples are tagged automatically from their file and folder names by the rules in `tag-rules.json` (File → Edit Tag Rules…, then rescan). Each rule is `{tag, pattern}` — a case-insensitive regex matched against the path below the library folder — or `{tag, folder}` for everything in a folder. The installed app keeps its copy at `~/Library/Application Support/sample-manager/tag-rules.json`.

Press **Enter** or **T** (or click a row's tag cell) to edit a sample's tags, comma-separated. Once you've edited a sample's tags, rescans leave them alone. Right-click a tag in the sidebar to delete it.

## Keyboard shortcuts

| Key | Action |
|---|---|
| ↑ / ↓, PgUp / PgDn, Home / End | Move (auditions when Auto-play is on); add ⇧ to extend the selection |
| Space | Play / pause |
| Enter or T | Edit tags (Enter saves, Esc cancels) |
| / or ⌘F | Search (↑/↓ still move the list while typing) |
| Enter (in search) | Keep the search as a chip and start another |
| `/` or `#` (in search) | Pick a folder / tag chip: ↑↓, Enter or Tab |
| Backspace (empty search) | Remove the last chip |
| ⌘Z / ⇧⌘Z | Undo / redo a tag edit (while typing: undo the typing) |
| ⌘A | Select all visible |
| R / ⇧R | Random sample / random sample with a random loop region |
| L | Loop on / off |
| I / O | Crop start / end at the playhead |
| Esc | Clear the crop (keeps playing); with no crop, stop |
| ⌥-scroll on the waveform | Zoom |
| ⌘[ / ⌘] | Back / forward |
| ⌥⌘R | Show current sample in Finder |
| ⌘O / ⇧⌘R | Add folder / rescan library |
| ⌃⌥Space | Quick Search, from anywhere |
| ⌘Q / ⌥⌘Q | Close to menu bar / quit |
