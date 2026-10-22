# Notes: design decisions, trust boundaries, production changes

## Summary

- The host page is treated as hostile. **No credential ever enters the page, the page's DOM, or the content script**, in either direction.
- The form runs in an **extension-origin iframe**: cross-origin to the page and in a separate process.
- The **service worker is the only code that touches the store**, and the only place a request is mapped to an origin.
- **The storage key always comes from the browser, never from a message.** It is the `sender.origin` that Chrome reports when the user clicks Open. A one-time panel token links the iframe to that click.

## Architecture

```
 Host page (untrusted, page origin, page renderer process)
 └─ content.js (isolated world, same renderer process as the page)
    └─ <injected-cred-root> closed shadow root
       ├─ [Open] button
       └─ <iframe src="chrome-extension://<id>/src/frame.html#<token>">   ← extension origin, extension process
              frame.js ──sendMessage({get|save, token, ancestorOrigins})──► background.js (service worker)
                                                                              │ binds request → origin
 content.js ──sendMessage({arm|disarm})  (no payload) ──────────────────────► │ storage.session: panel:<tabId>
                                                                              └ storage.local:   cred:<origin>
```

| Component | Trusted? | Responsibility |
| --- | --- | --- |
| [src/content.js](src/content.js) | Partly: our code, but it runs in the page's process | Draws the button. On a trusted click, arms the panel and mounts the iframe. Never handles credentials. |
| [src/frame.html](src/frame.html), [src/frame.js](src/frame.js) | Yes (extension origin) | Shows the form. Asks for "my" pair; never names an origin. Accepts no `postMessage`. |
| [src/background.js](src/background.js) | Yes | Origin binding, input validation, all storage reads and writes. |

## Trust boundaries

1. **Page ↔ content script.** They are separate JS worlds sharing one DOM and one renderer process. The page can see and tamper with the DOM we insert, so we use a closed shadow root and treat the DOM as tamperable. A compromised renderer could reach anything the content script can, so **we give the content script nothing worth stealing**: no credentials, and no storage access (`storage.local` is set to `TRUSTED_CONTEXTS`).
2. **Page ↔ extension iframe.** This is an origin boundary enforced by the browser, with site isolation keeping the two in separate processes. The page can embed `frame.html` (it's web-accessible), move it, or cover it, but it can't read its DOM or inputs.
3. **Extension contexts ↔ service worker.** Extension messaging goes through the browser process, which attaches a `MessageSender` (`url`, `origin`, `tab`, `frameId`, `documentId`) that a renderer can't forge. The service worker trusts **sender metadata**, not message bodies. Web pages have no channel at all, because there is no `externally_connectable`.
4. **Service worker ↔ disk.** `storage.local` is plaintext in the profile. This is accepted by the brief as a mock; see Production.

## Where plaintext goes

| Context | Sees plaintext? | Why |
| --- | --- | --- |
| Host page JS | **No** | The form is in a cross-origin iframe. Credentials are never in the page DOM, a URL, or a `postMessage`. |
| Content script | **No** | It sends only `arm` and `disarm`, which carry no data. It can't read `storage.local`, and the browser enforces that. |
| Extension iframe | **Yes, for the bound origin only** | It has to show and collect the pair, and it gets data only from the service worker. |
| Service worker | **Yes** | It owns the store; the pair sits in memory only while a request is being handled. |
| Frame ↔ SW messages | **Yes (in transit)** | Inside the browser's extension messaging; not visible to web content. |
| `storage.local` on disk | **Yes (mock)** | Allowed by the brief's credential-store stand-in. |

Beyond the extension's own code paths, plaintext is also visible to these, all of which belong to the user or the browser and not to the site:

| Where | What it exposes | Notes |
| --- | --- | --- |
| DevTools on the iframe | Input values, the `get` response | Opened with Inspect on the panel. It runs in the extension origin, so it isn't the page's DevTools context. |
| DevTools on the service worker | Messages being handled, plus `chrome.storage.local` under Application → Extension storage | Reached from `chrome://extensions` → "service worker". |
| Console | Nothing today | No code path logs credentials. The only `console` call is a warning if `setAccessLevel` fails. Error strings returned to the frame never include field values. Logging must stay that way. |
| Chrome's password manager | Possibly the typed pair | The form sets `autocomplete="off"`, but Chrome may still offer to save password fields. Production should verify this on `chrome-extension://` pages. |
| Extension process memory | The pair while the frame is open | Only reachable by something that already controls the extension process or the machine. |

The host page itself is not on this list. It can't open DevTools on another origin, read the frame, or see the service worker.

The panel token passes through the content script, which means it passes through page-reachable territory. It isn't a credential. At most it unlocks the top page's *own* origin, inside a frame the page can't read.

## How a lookup is bound to the site

1. **Arm.** When the user clicks Open, the content script checks `event.isTrusted` and sends `arm`. The service worker records `{documentId, origin}` from the browser-reported `sender.documentId` and `sender.origin`. It rejects non-http(s) and opaque origins (`null`, for example sandboxed pages). It then mints a random **panel token**, which the content script puts in the iframe's URL fragment.
2. **Request (`originForFrame`).** For `get` and `save`, the service worker requires all of the following:
   - `sender.url` is exactly our `frame.html`. This rejects content scripts and other extension pages.
   - The sender is a subframe in a tab and presents that tab's current token.
   - The token is bound to the **first frame document that redeems it**, so a second copy of `frame.html` can't reuse it.
   - `location.ancestorOrigins` is exactly `[armedOrigin]`, which means the frame is a **direct child of the top-level document**. The browser computes this in the frame's own extension process.
   - The armed top document is still `outermost_frame` and `active` (checked with `webNavigation.getFrame({documentId})`), and its URL origin still equals the armed origin.
3. Only then does it read or write `cred:<armedOrigin>`.

### The save flow

1. On load, the frame sends `get`. The form fields stay disabled until the service worker answers. If it returns `{ok: false}`, the frame shows "Unavailable" with the error and the form stays disabled.
2. On Submit, the frame calls `preventDefault()`, so nothing is submitted as a navigation or written into a URL. It disables the form, shows "Saving…" and sends `save` with the username and password.
3. The service worker runs the same `originForFrame` checks as for `get`, validates both fields and `await`s `chrome.storage.local.set` under `cred:<armedOrigin>`. Only then does it answer `{ok: true, origin}`.
4. The frame re-enables the form and shows "Saved." only after that answer. A rejection shows its error instead, such as a navigation during the save or a stale token. So "Saved." means the write has completed, and a reload or another path on the same origin will pre-fill the pair.

**Persistence.** Credentials live in `chrome.storage.local`, which is written to the profile and survives a browser restart. Only the per-tab panel records in `chrome.storage.session` are cleared on restart, and they hold tokens, not credentials.

**Key choice:** the key is the origin, not the URL. `https://a.com/x` and `https://a.com/y` share a pair. `http://a.com`, `https://sub.a.com` and `https://a.com:8443` don't.

### Who may send which message

**One entry point.** [background.js](src/background.js) registers a single `chrome.runtime.onMessage` listener and nothing else that receives messages:
- No `onMessageExternal` or `onConnectExternal`, so other extensions have no channel.
- No `externally_connectable`, so web pages have none either.
- No `onConnect` ports.
- No `window` `message` listeners in the frame or the content script, and no `runtime.onMessage` listener in either, so nothing can be pushed into them.

**Every message is checked before dispatch.** `handle()` first rejects any `sender.id !== chrome.runtime.id`. This duplicates what `onMessage` already guarantees, so it is defense in depth. It then rejects unknown `type` values. Each type is accepted only from one kind of sender, decided from browser-attested sender fields:

| Message | Accepted only from | Enforced by | Rejects |
| --- | --- | --- | --- |
| `arm`, `disarm` | Our content script in the top frame of a tab | `contentScriptContext`: `frameId === 0`, `sender.tab` and `sender.documentId` present, `sender.origin` is http(s) | Our iframe (it's a subframe with a `chrome-extension://` origin), other extension pages, and subframe content scripts |
| `get`, `save` | Our `frame.html` as a subframe in a tab | `originForFrame`, steps 1–2: `sender.url` is exactly `frame.html`, and `sender.tab`, a non-zero `frameId` and `sender.documentId` are all present | The content script (its `sender.url` is the page), and `frame.html` opened as a top-level tab |

**Details that are easy to miss:**
- **`disarm` only affects the document that armed.** It clears `panel:<tabId>` only if the sender's `documentId` matches the armed one, so a different document in the same tab can't close a newer panel.
- **Re-arming invalidates the old token.** Each `arm` mints a fresh token and resets `frameDocumentId`, so a token from an earlier Open stops working.
- **Two inputs come from the message body: `token` and `ancestorOrigins`.**
  - `token` is a capability, not an identity, and it's compared exactly against the stored value.
  - `ancestorOrigins` is only as trustworthy as the code reporting it. That code is our own `frame.js`, running in the extension process. A page that embeds its own copy of `frame.html` runs the same code, so the copy reports its real ancestors. Only a compromised extension process could lie here, and that is out of scope (see Known gaps).
- **The service worker can't see the click.** The "trusted user click" requirement is checked by `event.isTrusted` in the content script. A compromised renderer could send `arm` without a click. That only unlocks the top document's own origin, in a frame the page can't read.
- **Failures are reported, not thrown.** They come back as `{ ok: false, error }`, and the error messages never include credential data.

### What stops a hostile page

| Attack | Why it fails |
| --- | --- |
| Asking for another origin's pair | The page has no channel to the service worker, and no message accepts an origin to look up. |
| Embedding `frame.html` itself | It has no token. Getting one takes a trusted click on a button inside a closed shadow root, and synthetic clicks fail `isTrusted`. |
| An ad or widget iframe on `good.com` embedding `frame.html` | No token, and `ancestorOrigins` has two entries. Without this check, `good.com`'s pair could be pre-filled inside an attacker's frame, ready for clickjacking. |
| Navigating while a save is in flight | Binding is to a `documentId`, so once the top document is gone the request fails. The old form's data can't land under the new origin. |

### Why the page can't change the bound origin

The origin is fixed once, at `arm`, from `sender.origin`. That value is the committed origin of the top-level document, as recorded by the browser process. Every `get` and `save` then rechecks it against the live top document's URL ([background.js](src/background.js), `originForFrame` step 6). No value the page controls feeds into it, so none of the following changes which `cred:<origin>` entry is used:

| Page tries… | Why the origin doesn't change |
| --- | --- |
| Setting `document.domain` | It changes the effective domain for same-site scripting, not the origin. Chrome also keys agent clusters by origin by default, which turns the setter into a no-op. |
| Serving itself with CSP `sandbox` (or loading as a sandboxed document) | The origin becomes opaque (`null`), and `arm` rejects anything that isn't http(s). The sandbox flags are also inherited by `frame.html`, which then can't reach `chrome.runtime`. |
| `history.pushState` / `replaceState` to another URL | These can only change the URL within the same origin, and the key is the origin, not the path. |
| Navigating, a back/forward-cache restore, prerendering | The binding is to a `documentId`. A new document never matches it, and a cached or prerendering document fails the `documentLifecycle === 'active'` and `outermost_frame` checks. |
| Making `about:blank`, `blob:`, `data:` or `srcdoc` the top document | The content script only matches http/https top frames (no `match_origin_as_fallback`), so there is no Open button and no `arm`. |
| Opening `frame.html` as a top-level tab or popup | `frameId` is 0, so `originForFrame` rejects it. |
| Putting `frame.html` in a fenced frame or a nested iframe (including one from the same origin) | `ancestorOrigins` must be exactly `[armedOrigin]`. A nested frame reports two entries, and a fenced frame reports none. |
| Opening the panel in one tab and using its token in another | The panel record is keyed by `sender.tab.id`, so a frame in another tab looks up that tab's record. |
| Its own CSP (`frame-src`), COEP or Permissions-Policy | These can at most stop the iframe loading (a denial of service). They can't change the origin of the frame or of the top document. |
| CORS, or `fetch()` of `frame.html` | Iframe loads aren't subject to CORS. Fetching the web-accessible file returns static HTML with no secrets (it only reveals the extension is installed). |
| `postMessage` to the frame or the content script | No one listens. |
| Stealing or racing the panel token (for example by reading the iframe's `src`) | The token decides which frame may speak, not which origin is used. A page-embedded copy that redeems it first still gets only the armed (that is, the page's own) origin, in a frame the page can't read. The legitimate panel then fails with "Token already used", which is a denial of service, not a leak. |
| Opening the panel again | Each `arm` comes from the current top document, so the new origin is still that document's own. The old token stops working. |

What the page *can* do is attack the panel's UI and availability rather than its origin binding: hide or cover it, navigate the iframe away (`frames[n].location = …`), steal focus while the user types, or move the host element so the iframe reloads and fails the token check. See Known gaps.

## Button placement

The content script appends a custom element, `<injected-cred-root>`, to `<html>` rather than `<body>`, so pages that replace `body` don't remove it. The host element is styled inline, with every rule marked `!important`: `all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647` (the maximum 32-bit z-index). It overlays the page content at the top right. The button and the iframe live inside a closed shadow root, so page CSS can't restyle them and page JS can't reach them.

This is best effort. The page owns the DOM, so it can still:
- remove the host element, or move it, which reloads the iframe and fails the token check;
- override its inline styles with script;
- place its own element at the same maximum z-index later in the DOM, or use the top layer (`<dialog>.showModal()`, the Popover API, fullscreen), which always paints above any z-index.

**Paint order matters more than z-index.** The maximum z-index doesn't guarantee the button is on top. z-index only orders elements within the same stacking context, and the page can give its own overlay the same maximum value. When two positioned elements in the same stacking context have equal z-index, the one later in the DOM paints on top. We append the host once, at injection, so any element the page adds to the end of `<html>` afterwards at `z-index: 2147483647` covers the button, with no CSS trick needed. Only the top layer sits above this ordering, and the page can use it too.

Possible improvements:
- **A `MutationObserver`** on `<html>` and on the host element's `style` attribute, to re-attach the host and restore its styles when the page removes or changes them. It could also move the host back to the end of `<html>` whenever the page appends after it, so it stays last in paint order. Moving the host reloads the iframe, so this should only happen while the panel is closed. This is an arms race the page can still win (for example by covering the button with its own overlay), but it defeats casual or accidental breakage.
- **Using the top layer ourselves.** Opening the panel as a modal `<dialog>` with `showModal()`, or as a `popover` element, puts it in the browser's top layer, above every z-index. It also makes the rest of the page inert while the panel is open. The page can still close the dialog or add its own top-layer element afterwards, so this raises the bar rather than guaranteeing visibility. The real fix is moving the form out of the page entirely (see For production).

## Use of AI

I used a coding assistant for most of the implementation and as a sounding board on architecture: choosing between an in-page form and an iframe, where storage access should live, how to bind requests to an origin, and enumerating the hostile-page attacks above. I reviewed and tested the output in Chrome and corrected it where it was wrong. The clearest case is the webNavigation parent lookup (under Decisions below). It looked right but fails in practice, because Chrome doesn't report `chrome-extension://` frames, so I replaced it with the panel token.

## Decisions and alternatives considered

- **Iframe instead of an in-page form, even in a closed shadow root.** A shadow root hides elements from page JS, but the page can still log keystrokes with capturing listeners on `window`, and it shares the process. Only an iframe gives a real origin and process boundary.
- **The service worker as the only storage reader.** The frame could call `chrome.storage` itself (it's a trusted context), but routing through the service worker:
  - **Limits what a frame bug can leak.** `frame.html` is web-accessible, so it's our most exposed trusted code. Given direct access, an XSS there could run `storage.local.get(null)`. Through messaging it gets only the bound origin's pair.
  - **Uses browser-attested identity.** The checks rely on `sender.documentId`, `tab` and `frameId`. The frame can't reliably learn these about itself, so a rogue copy could claim anything.
  - **Keeps the token meaningful.** If the frame could read `storage.session`, it could read the `panel:<tabId>` record and the token would prove nothing.
  - **Puts the binding in one place.** One function gates every `cred:*` access, and future UIs (popup, side panel) reuse it.

  This is a convention, not enforced: Chrome can't stop extension pages from calling storage. Enforcing it needs encryption with a key only the service worker can get (see Production).
- **A panel token instead of webNavigation parent lookups.** My first version asked `webNavigation.getFrame` for the iframe's parent. Chrome doesn't report `chrome-extension://` frames to webNavigation, so every request failed with "Frame must be a direct child of the top document". The token replaces that missing link. webNavigation is still used for the top document, which is http(s) and visible to it.
- **Binding to documents, not tabs or URLs.** A tab outlives navigations, and a URL string can be reused. A `documentId` identifies exactly one page load.
- **Session state in `storage.session`.** MV3 service workers stop when idle, and a user may leave the form open before submitting, so an in-memory variable would be lost. `storage.session` stays in memory, is cleared on browser restart, and only trusted contexts can read it by default.
- **Permissions.** `storage` and `webNavigation` (which shows a "read your browsing history" warning). I didn't use `tabs`, because `tabs` identifies the tab rather than the specific page load. The content script runs only on http/https, top frame only (`all_frames: false` plus a `window.top` check).
- **No dependencies or build step.** The surface is about 200 lines, and a framework would add supply-chain risk without much benefit.
- **Validation.** Strings only, at most 1024 characters, username required. Unknown message types are rejected.

## Known gaps

- **UI integrity.** The page owns its DOM, so it can hide, remove, restyle or cover our host element. It can't *read* anything, but it can clickjack or show a fake form next to ours.
- **Fingerprinting.** The host element and the web-accessible `frame.html` reveal that the extension is installed.
- **Plaintext at rest. Not production safe.** `chrome.storage.local` writes the pair unencrypted into the Chrome profile directory. Anything with access to the user's files can read every saved credential: malware, another local user, a backup, a synced or copied profile, or a forensic image. Access is gated only by file permissions, with no user verification and no auto-lock. This is acceptable here only because the brief calls the store a mock and the credentials are synthetic. A real vault is the first item under For production.
- **No end-to-end tests yet.** Verification so far is manual in Chrome. Before relying on this, each cross-origin hijacking or credential-theft scenario in this document should be an automated test: Playwright with the unpacked extension loaded, served from several local origins. Each test should assert that the attempt fails and that no other origin's pair is ever returned:
  - **Another origin's pair:** save on origin A, then open the panel on origin B, on a subdomain, on another port and on `http:` versus `https:`. Each must start blank.
  - **Page-embedded `frame.html`:** a page iframes it with no token, with a guessed token, and with a token copied from the real panel. Each must be rejected or limited to the page's own origin.
  - **Nested and third-party frames:** a cross-origin ad frame on origin A embeds `frame.html`, and so does a same-origin nested frame. `ancestorOrigins` must cause rejection.
  - **Synthetic clicks:** `button.click()`, `dispatchEvent(new MouseEvent('click'))` and keyboard events from page script must not arm the panel.
  - **Navigation during a save:** start a save, navigate the top document to origin B before it completes, then confirm nothing was written under either origin.
  - **Token reuse:** a token from a previous Open, a token used in another tab, and a second frame redeeming an already used token.
  - **Origin spoofing:** `document.domain`, `pushState` and `replaceState`, a CSP `sandbox` page, `about:blank`/`blob:`/`data:` top documents, bfcache restores and prerendering.
  - **Top-level `frame.html`:** opened as a tab and as a popup must be rejected.
  - **Page-side reads:** page script tries `postMessage`, reads the iframe's DOM and `src`, and fetches `frame.html`. None may yield credential data.
  - **Plaintext leaks:** after a save, check that the pair appears in no URL, no page-visible DOM, no console output and no error string.
  - **Persistence:** save, restart the browser profile, and confirm the pair pre-fills.
- The service worker trusts all of the extension's own origin. A compromised extension page is out of scope.
- Session records are cleared on Close and when the tab closes, but they don't expire while idle.

## For production

- **A real vault.** Encrypt at rest with a key held outside the extension (OS keychain via native messaging, or a server-side vault behind authentication). Require user verification to unlock (biometrics, PIN or WebAuthn) and auto-lock. Send the password to the frame only on an explicit reveal or fill action.
- **Move sensitive UI out of the page.** The side panel, the action popup or a separate window can't be overlaid by the page. The in-page button would only open it.
- **If the UI stays in the page:** use IntersectionObserver v2 (`trackVisibility`) to refuse input while the frame is occluded, plus an input delay after the frame appears.
- **Origin policy.** Decide between exact origin and eTLD+1 (Public Suffix List), warn on or refuse `http:`, and show IDN/homograph-safe origins.
- **Smaller footprint.** `activeTab` or `optional_host_permissions` with per-site opt-in, instead of injecting on every page. `use_dynamic_url` for the web-accessible resource.
- **Operational.** Rate-limit `get`, expire tokens, and log or report rejected requests.
- **Tests.** The end-to-end suite listed under Known gaps, run in CI on every change.
