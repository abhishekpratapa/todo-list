// The "Use Another Mac's List" window: asks for the other Mac's address and its
// access token, and hands them to the app (electron/connect.js), which checks
// them and either closes this window or says what is wrong.

const $ = (sel) => document.querySelector(sel);
const app = window.todosConnect; // from electron/connect-preload.cjs

// Reconnecting to the same Mac: its address is filled in already.
const address = new URLSearchParams(location.search).get('address');
if (address) {
  $('#address').value = address;
  $('#token').focus();
}

function showError(message) {
  $('#error').textContent = message;
  $('#error').hidden = !message;
}

$('#connect').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const button = $('#submit');
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    const answer = await app.connect($('#address').value, $('#token').value);
    if (answer?.error) showError(answer.error);
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Connect';
  }
});

$('#cancel').addEventListener('click', () => app.cancel());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') app.cancel();
});
