const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const form = document.querySelector('#activate-form');
const context = document.querySelector('#invite-context');
const error = document.querySelector('#invite-error');
async function request(action, values) {
  const response = await fetch('/api/invitations/' + action, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...values }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la activación.');
  return data;
}
try {
  const invitation = await request('inspect');
  context.textContent = `${invitation.business} · ${invitation.email}`;
  form.hidden = false;
} catch (problem) {
  context.textContent = 'Necesitas una invitación vigente para activar tu acceso.';
  error.textContent = problem.message;
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const values = new FormData(form);
  if (values.get('password') !== values.get('confirmation')) {
    error.textContent = 'Las contraseñas no coinciden.';
    return;
  }
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await request('accept', { password: values.get('password') });
    form.reset();
    form.hidden = true;
    context.textContent = 'Acceso activado. Ya puedes iniciar sesión con tu correo y contraseña.';
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
});
