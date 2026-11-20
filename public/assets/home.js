// Home page: open a page by name, random page, recently opened pages.

const RECENT_KEY = 'openpad:recent';

const form = document.getElementById('go-form');
const input = document.getElementById('name');

document.getElementById('host-label').textContent = `${location.host}/`;

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

renderRecent();
input.focus();
