# Injected Credential Form (MV3)

A Chrome Manifest V3 extension. It adds an **Open** button to every top-level http/https page. Clicking it opens an extension-hosted form that saves a synthetic username/password pair for the page's origin and pre-fills that pair on later visits. Vanilla JS, no dependencies, no build step.

**Design decisions, trust boundaries and production notes: see [NOTES.md](NOTES.md).**

## Load it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Visit any `https://` page and click **Open** (top right). Enter credentials and click **Submit**.
3. Reload the page, or go to another path on the same origin, and click **Open**: the form is pre-filled. A different origin starts blank. The data is in `chrome.storage.local`, so it survives a browser restart.

After reloading the extension, also reload any open pages. Content scripts injected by the previous version stop working.

Requires Chrome 116+ (uses `sender.documentId`/`sender.origin`, `webNavigation.getFrame({documentId})`, and `storage.local.setAccessLevel`).

## Layout

| File | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV3 manifest: `storage` and `webNavigation` permissions, http/https content script, web-accessible `frame.html`. |
| [src/content.js](src/content.js) | Button and iframe mount, inside a closed shadow root. Never handles credentials. |
| [src/frame.html](src/frame.html), [src/frame.js](src/frame.js), [src/frame.css](src/frame.css) | The extension-origin form. |
| [src/background.js](src/background.js) | Service worker: origin binding, validation, storage. |
