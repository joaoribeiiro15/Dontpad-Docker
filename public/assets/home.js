// Página inicial (secção 9.1).

const form = document.getElementById('go-form');
const input = document.getElementById('name');

document.getElementById('host-label').textContent = `${location.host}/`;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const segments = name.split('/').filter((s) => s !== '');
  if (segments.length === 0) return;
  location.href = '/' + segments.map(encodeURIComponent).join('/');
});

input.focus();
