// Home page: open a page by name, random page, recently opened pages.

const RECENT_KEY = 'openpad:recent';

const form = document.getElementById('go-form');
const input = document.getElementById('name');

const hostLabel = document.getElementById('host-label');

function pathFor(name) {
  const segments = name.split('/').map((s) => s.trim()).filter((s) => s !== '');
  return segments.length ? '/' + segments.map(encodeURIComponent).join('/') : null;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const target = pathFor(input.value.trim());
  if (!target) {
    form.classList.remove('shake');
    void form.offsetWidth; // restart the animation
    form.classList.add('shake');
    input.focus();
    return;
  }
  location.href = target;
});

const ADJECTIVES = ['amber', 'brisk', 'calm', 'clever', 'cosmic', 'gentle', 'golden', 'lucky', 'misty', 'quiet', 'rapid', 'silver', 'sunny', 'swift', 'velvet', 'wild'];
const NOUNS = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'meadow', 'pebble', 'river', 'canyon', 'ember', 'lagoon', 'orchid', 'summit', 'willow', 'aurora', 'cedar'];

document.getElementById('btn-random').addEventListener('click', () => {
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  const name = `${ADJECTIVES[bytes[0] % ADJECTIVES.length]}-${NOUNS[bytes[1] % NOUNS.length]}-${(bytes[2] % 9000) + 1000}`;
  location.href = '/' + name;
});

// ---- Recently opened (stored only in this browser) -------------------------

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string') : [];
  } catch {
    return [];
  }
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function renderRecent() {
  const section = document.getElementById('recent');
  const list = document.getElementById('recent-list');
  const items = readRecent().slice(0, 8);
  section.hidden = items.length === 0;
  list.replaceChildren(
    ...items.map((item, index) => {
      const li = document.createElement('li');
      li.style.animationDelay = `${0.5 + index * 0.04}s`;
      const a = document.createElement('a');
      a.href = item.path.split('/').map(encodeURIComponent).join('/');
      const name = document.createElement('span');
      name.textContent = item.path;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = ago(item.at);
      a.append(name, when);
      li.append(a);
      return li;
    }),
  );
}

document.getElementById('recent-clear').addEventListener('click', () => {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // ignore
  }
  renderRecent();
});

// ---- First-run setup: the address people use to reach this server ----------

const LATER_KEY = 'openpad:setup-later';
const LOCAL_HOST = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$|\.(local|lan|home|internal|localhost)$/i;

/** Mirrors the server's normalization, for the live preview only. */
function previewOrigin(raw) {
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const hostPart = value.split(/[/?#]/)[0].replace(/:\d+$/, '');
    value = `${LOCAL_HOST.test(hostPart) ? 'http' : 'https'}://${value}`;
  }
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) return null;
    return url;
  } catch {
    return null;
  }
}

function setupLater() {
  try {
    return sessionStorage.getItem(LATER_KEY) === '1';
  } catch {
    return false;
  }
}

function startSetup() {
  const overlay = document.getElementById('setup');
  const form = document.getElementById('setup-form');
  const field = document.getElementById('setup-address');
  const link = document.getElementById('setup-link');
  const error = document.getElementById('setup-error');
  const save = document.getElementById('setup-save');

  field.value = location.host;

  function renderPreview() {
    const url = previewOrigin(field.value);
    field.classList.toggle('invalid', Boolean(field.value.trim()) && !url);
    link.replaceChildren();
    if (!url) {
      link.textContent = field.value.trim() ? 'That does not look like an address.' : 'Links will look like this.';
      return;
    }
    const strong = document.createElement('b');
    strong.textContent = url.host;
    link.append(`${url.protocol}//`, strong, '/your-secret-page');
  }

  function close() {
    overlay.classList.add('leaving');
    overlay.classList.remove('show');
    setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove('leaving');
      input.focus();
    }, 350);
  }

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
    field.focus();
  }

  field.addEventListener('input', () => {
    error.hidden = true;
    renderPreview();
  });

  document.getElementById('setup-later').addEventListener('click', () => {
    try {
      sessionStorage.setItem(LATER_KEY, '1');
    } catch {
      // ignore
    }
    close();
  });

  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.getElementById('setup-later').click();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!previewOrigin(field.value)) return fail('Type a domain or an IP address, for example notes.example.com or 192.168.1.20:3000.');
    save.disabled = true;
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ address: field.value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        hostLabel.textContent = `${data.host}/`;
        hostLabel.classList.add('updated');
        document.body.dataset.setup = 'done';
        close();
        return;
      }
      if (data.error === 'already-configured' || data.error === 'configured-by-env') {
        // Someone else finished the setup first: show what is stored now.
        location.reload();
        return;
      }
      fail(data.error === 'invalid-address' ? 'The server did not accept that address. Use only a domain or IP, with an optional port.' : 'Could not save the address. Try again.');
    } catch {
      fail('Could not reach the server. Try again.');
    } finally {
      save.disabled = false;
    }
  });

  renderPreview();
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('show'));
  field.focus();
  field.select();
}

renderRecent();
if (document.body.dataset.setup === 'required' && !setupLater()) startSetup();
else input.focus();
