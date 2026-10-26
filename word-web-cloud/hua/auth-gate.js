const gate = document.querySelector('#auth-gate');
const form = document.querySelector('#auth-form');
const input = document.querySelector('#auth-code');
const message = document.querySelector('#auth-message');
const submit = form.querySelector('button[type="submit"]');
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const basePath = location.pathname.startsWith('/hua') ? '/hua' : '';
const apiUrl = (name) => `${basePath}/api/${name}`;

async function startApp() {
  gate.hidden = true;
  document.body.classList.remove('auth-pending');
  await import('./app.js?v=20261026-1');
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

async function checkSession() {
  if (isLocal && new URLSearchParams(location.search).get('auth') !== '1') {
    await startApp();
    return;
  }
  try {
    const response = await fetch(apiUrl('auth'), { cache: 'no-store', credentials: 'same-origin' });
    const result = await response.json();
    if (response.ok && result.authenticated) {
      await startApp();
      return;
    }
  } catch {}
  gate.classList.add('ready');
  input.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = input.value.trim();
  if (!code) return;
  submit.disabled = true;
  showMessage('正在验证…');
  try {
    const response = await fetch(apiUrl('login'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '验证失败，请稍后再试');
    input.value = '';
    await startApp();
  } catch (error) {
    showMessage(error.message || '验证失败，请稍后再试', true);
    input.select();
  } finally {
    submit.disabled = false;
  }
});

checkSession();
