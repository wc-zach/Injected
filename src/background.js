// Service worker: the only context that reads or writes the credential store,
// and the only place a request is bound to an origin. Origins are derived from
// browser-supplied sender metadata, never from message payloads.

const FRAME_URL = new URL(chrome.runtime.getURL('src/frame.html'));
const MAX_FIELD_LENGTH = 1024;

// Keep the credential store out of reach of content scripts (which run in the
// host page's renderer process). Our content script never calls storage, but a
// compromised renderer could; this makes the browser enforce it.
chrome.storage.local
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch((err) => console.warn('storage.local setAccessLevel failed:', err));
// storage.session already defaults to TRUSTED_CONTEXTS.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(panelKey(tabId));
});

async function handle(msg, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('Unknown sender');

  switch (msg?.type) {
    case 'arm':
      return arm(sender);
    case 'disarm':
      return disarm(sender);
    case 'get': {
      const origin = await originForFrame(msg, sender);
      const cred = (await chrome.storage.local.get(credKey(origin)))[credKey(origin)];
      return { origin, username: cred?.username ?? '', password: cred?.password ?? '' };
    }
    case 'save': {
      const origin = await originForFrame(msg, sender);
      const { username, password } = msg;
      validateField(username, 'username', { allowEmpty: false });
      validateField(password, 'password', { allowEmpty: true });
      await chrome.storage.local.set({ [credKey(origin)]: { username, password } });
      return { origin };
    }
    default:
      throw new Error('Unknown message type');
  }
}

// --- Arming -----------------------------------------------------------------
// The content script calls `arm` after a trusted user click on Open. We record
// which top-level *document* (not just tab) the panel was opened for, plus the
// browser-reported origin of that document, and mint a one-time token that the
// content script hands to the iframe it creates. Frame requests are only
// honored for that token, from the first frame document that redeems it, while
// that exact top-level document is still live.
//
// (webNavigation does not report chrome-extension:// frames, so we cannot ask
// the browser who our iframe's parent is; the token carries that link instead.)

function contentScriptContext(sender) {
  const isTopFrame = sender.frameId === 0 && sender.tab?.id !== undefined;
  const origin = sender.origin;
  if (!isTopFrame || !sender.documentId) throw new Error('Not a top-level content script');
  if (!/^https?:\/\//.test(origin ?? '')) throw new Error('Unsupported origin');
  return { tabId: sender.tab.id, documentId: sender.documentId, origin };
}

async function arm(sender) {
  const { tabId, documentId, origin } = contentScriptContext(sender);
  const token = crypto.randomUUID();
  await chrome.storage.session.set({
    [panelKey(tabId)]: { documentId, origin, token, frameDocumentId: null },
  });
  return { token };
}

async function disarm(sender) {
  const { tabId, documentId } = contentScriptContext(sender);
  const panel = await getPanel(tabId);
  if (panel?.documentId === documentId) await chrome.storage.session.remove(panelKey(tabId));
  return {};
}

// --- Origin binding for the iframe ------------------------------------------

async function originForFrame(msg, sender) {
  // 1. Must be our frame page, not a content script or another extension page.
  const url = new URL(sender.url ?? 'about:blank');
  if (url.origin !== FRAME_URL.origin || url.pathname !== FRAME_URL.pathname) {
    throw new Error('Not the credential frame');
  }

  // 2. Must be a subframe in a tab.
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.frameId || !sender.documentId) throw new Error('Frame not in a tab');

  // 3. Must present the token minted when the user clicked Open in this tab
  //    (rejects a page that embeds frame.html itself: it never got a token).
  const panel = await getPanel(tabId);
  if (!panel || typeof msg.token !== 'string' || msg.token !== panel.token) {
    throw new Error('Panel not opened by user for this page');
  }

  // 4. The frame must sit directly under the top-level document (rejects our
  //    frame nested inside a third-party iframe). ancestorOrigins is computed
  //    by the browser in the frame's own (extension) process.
  const ancestors = msg.ancestorOrigins;
  if (!Array.isArray(ancestors) || ancestors.length !== 1 || ancestors[0] !== panel.origin) {
    throw new Error('Frame must be a direct child of the top document');
  }

  // 5. The armed top-level document must still be the live one (rejects a
  //    request that lands after the page navigated away).
  const top = await chrome.webNavigation.getFrame({ documentId: panel.documentId }).catch(() => null);
  if (!top || top.frameType !== 'outermost_frame' || top.documentLifecycle !== 'active') {
    throw new Error('Page has navigated away');
  }
  if (new URL(top.url).origin !== panel.origin) throw new Error('Origin mismatch');

  // 6. Only a frame that passed every check may claim the token, so a frame
  //    that is going to be rejected can't burn it for the real panel. The
  //    token is bound to the first such frame document, so a second embedding
  //    of frame.html can't reuse it. Re-read the record: a re-arm during the
  //    awaits above may have replaced it, and writing back the stale copy
  //    would revive the old token.
  const current = await getPanel(tabId);
  if (!current || current.token !== msg.token) {
    throw new Error('Panel not opened by user for this page');
  }
  if (current.frameDocumentId === null) {
    current.frameDocumentId = sender.documentId;
    await chrome.storage.session.set({ [panelKey(tabId)]: current });
  } else if (current.frameDocumentId !== sender.documentId) {
    throw new Error('Token already used by another frame');
  }

  return current.origin;
}

// --- Helpers ----------------------------------------------------------------

function credKey(origin) {
  return `cred:${origin}`;
}

function panelKey(tabId) {
  return `panel:${tabId}`;
}

async function getPanel(tabId) {
  return (await chrome.storage.session.get(panelKey(tabId)))[panelKey(tabId)];
}

function validateField(value, name, { allowEmpty }) {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} is required`);
  if (value.length > MAX_FIELD_LENGTH) throw new Error(`${name} too long`);
}
