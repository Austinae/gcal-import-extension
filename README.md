# GCal Quick Import

Chrome extension (Manifest **V3**) that adds a small **Import events** panel on [Google Calendar](https://calendar.google.com). Drop an `.ics` file (or use **Choose file**) to import without going through **Settings → Import & export**.

## How it works

Google Calendar’s web app does not expose a stable public “upload ICS” HTTP API. The request you captured in `raw event.txt` is an internal `sync.sync` RPC with session-specific tokens and protobuf payloads.

This extension uses the **same user-facing path** as Settings → Import: it opens (or navigates to) `/r/settings/export`, attaches your file to Google’s file input in the page’s JavaScript world, optionally picks a calendar, and clicks **Import**. That flow triggers the same backend import (including `sync.sync`) with valid session state.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open Google Calendar — you should see the panel at the bottom-right (above the footer)

## Options

Click the extension icon in the toolbar:

- **Quick mode** (default): imports in a background tab using the default calendar name (or the dropdown’s current selection if the name is empty)
- **Pick mode**: navigates you to the Import settings page with the file pre-filled so you can choose the calendar and click **Import**

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | Jobs, background tab, MAIN-world file attach |
| `content.js` | Drop panel + `/settings/export` automation |
| `content.css` | Panel and toast styles |
| `popup.html` / `popup.js` | Extension options |

## Permissions

- `https://calendar.google.com/*` — inject UI and drive the native import page
- `storage` — save default calendar / mode
- `scripting` — attach files in the page MAIN world (required for Google’s controls)