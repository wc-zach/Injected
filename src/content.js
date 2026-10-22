// Content script: runs in an isolated world inside the (untrusted) host page.
// It only draws the Open button and mounts the extension iframe. It never sees
// credentials and never touches storage.

(() => {
  if (window.top !== window) return;
  if (globalThis.__injectedCredMounted) return; // isolated-world global, invisible to the page
  globalThis.__injectedCredMounted = true;

  const FRAME_SRC = chrome.runtime.getURL('src/frame.html');

  const host = document.createElement('injected-cred-root');
  host.style.cssText =
    'all: initial !important; position: fixed !important; top: 12px !important; right: 12px !important; z-index: 2147483647 !important;';

  // Closed shadow root: page scripts can't reach the button or the iframe
  // element (and so can't read its src or call .click() on the button).
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; font: 13px system-ui, sans-serif; }
      button {
        all: initial; cursor: pointer; font: 600 13px system-ui, sans-serif;
        background: #1f2937; color: #fff; padding: 6px 14px; border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,.25);
      }
      button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
      iframe {
        width: 300px; height: 230px; border: 0; border-radius: 8px;
        background: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.3); color-scheme: normal;
      }
    </style>
    <div class="wrap"><button type="button">Open</button></div>
  `;

  const wrap = shadow.querySelector('.wrap');
  const button = shadow.querySelector('button');
  let frame = null;

  button.addEventListener('click', async (event) => {
    if (!event.isTrusted) return; // only real user clicks may open the panel

    if (frame) {
      frame.remove();
      frame = null;
      button.textContent = 'Open';
      chrome.runtime.sendMessage({ type: 'disarm' });
      return;
    }

    // Tell the service worker this top-level document opened the panel. It
    // records our browser-verified documentId/origin (the payload carries
    // nothing) and returns a one-time token for the iframe we're about to make.
    const res = await chrome.runtime.sendMessage({ type: 'arm' });
    if (!res?.ok) return;

    frame = document.createElement('iframe');
    frame.src = `${FRAME_SRC}#${res.token}`;
    frame.title = 'Saved credentials';
    frame.allow = '';
    frame.referrerPolicy = 'no-referrer';
    wrap.append(frame);
    button.textContent = 'Close';
  });

  // Attach to <html> rather than <body> so pages that replace body keep it.
  document.documentElement.append(host);
})();
