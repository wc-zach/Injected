// Extension-origin iframe. Cross-origin to the host page, so the page cannot
// read its DOM. It never states which origin it wants: the service worker
// derives that from the browser's sender metadata. It accepts no postMessage.

const form = document.getElementById('form');
const usernameEl = document.getElementById('username');
const passwordEl = document.getElementById('password');
const submitEl = document.getElementById('submit');
const originEl = document.getElementById('origin');
const statusEl = document.getElementById('status');

// Capability handed over by the content script; it identifies the panel the
// user opened, not an origin. ancestorOrigins is filled in by the browser.
const token = location.hash.slice(1);
const ancestorOrigins = Array.from(location.ancestorOrigins);

function request(type, fields = {}) {
  return chrome.runtime.sendMessage({ type, token, ancestorOrigins, ...fields });
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function setEnabled(enabled) {
  usernameEl.disabled = passwordEl.disabled = submitEl.disabled = !enabled;
}

async function load() {
  const res = await request('get');
  if (!res?.ok) {
    originEl.textContent = 'Unavailable';
    setStatus(res?.error ?? 'Could not load', true);
    return;
  }
  originEl.textContent = `For ${res.origin}`;
  originEl.title = res.origin;
  usernameEl.value = res.username;
  passwordEl.value = res.password;
  setEnabled(true);
  usernameEl.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setEnabled(false);
  setStatus('Saving…');
  const res = await request('save', { username: usernameEl.value, password: passwordEl.value });
  setEnabled(true);
  setStatus(res?.ok ? 'Saved.' : res?.error ?? 'Save failed', !res?.ok);
});

load();
