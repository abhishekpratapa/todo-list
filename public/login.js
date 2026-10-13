// Sign-in page: exchanges the access token for a session cookie. The token is
// sent once, in the request body, and is never stored by this page.

const form = document.querySelector('#signin');
const input = document.querySelector('#token');
const button = document.querySelector('#submit');
const error = document.querySelector('#error');

function fail(message) {
  error.textContent = message;
  error.hidden = false;
  button.disabled = false;
  input.select();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch('/api/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: input.value.trim() }),
    });
    if (res.ok) return location.replace('/');
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) return fail(`Too many attempts. Try again in ${Math.ceil((Number(res.headers.get('Retry-After')) || 60) / 60)} min.`);
    fail(data.error?.message || 'Could not sign in.');
  } catch {
    fail('Could not reach your Mac. Check that Todos and Tailscale are running there.');
  }
});
