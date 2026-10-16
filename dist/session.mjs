export function createSaveQueue({ revision, transport, status }) {
  let pending = null, active = false, failure = null;
  async function pump() {
    if (active || failure || pending === null) return;
    active = true;
    status('Guardando…', 'pending');
    while (pending !== null && !failure) {
      const current = pending;
      pending = null;
      try {
        const result = await transport(current, revision);
        revision = result.revision;
      } catch (error) {
        if (pending === null) pending = current;
        failure = error;
      }
    }
    active = false;
    if (failure) status(failure.message, 'error', failure.status);
    else status('Guardado en servidor', 'saved');
  }
  return {
    save(state) { pending = JSON.stringify(state); void pump(); },
    retry() { if ([401, 409].includes(failure?.status)) return; failure = null; void pump(); },
    hasUnsaved() { return active || pending !== null; }
  };
}

export async function openConversaSession() {
  if (document.documentElement.dataset.storage === 'local' || location.protocol === 'file:') return { mode: 'local' };
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
    } catch { const error = new Error('No se pudo contactar al servidor. Conserva esta pestaña y vuelve a intentar.'); error.status = 503; throw error; }
    let value;
    try { value = await response.json(); }
    catch { const error = new Error('El servidor de Conversa no está disponible. Revisa la instalación y vuelve a intentar.'); error.status = 503; throw error; }
    if (!response.ok) { const error = new Error(value.error || 'No se pudo completar la operación.'); error.status = response.status; throw error; }
    return value;
  }
  document.body.classList.add('auth-pending');
  const screen = document.createElement('section');
  screen.className = 'auth-screen';
  screen.innerHTML = '<div class="auth-card"><div class="auth-logo">conversa.</div><h1>Tu espacio de trabajo</h1><p>Inicia sesión para acceder a tus campañas y prospectos.</p><form id="account-login"><label class="field">Correo<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label class="field">Contraseña<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button class="btn primary" type="submit">Entrar</button></form><p class="auth-error" role="alert"></p><button class="btn auth-retry" type="button" hidden>Volver a intentar</button><p class="fine-print">Los accesos los crea el administrador. Las conexiones y mensajes de redes siguen en modo de prueba.</p></div>';
  document.body.append(screen);
  const login = screen.querySelector('form'), note = screen.querySelector('.auth-error'), retry = screen.querySelector('.auth-retry');
  let user, loaded;
  while (!loaded) {
    try {
      ({ user } = await request('/api/session'));
      loaded = await request('/api/state');
    } catch (error) {
      if (error.status === 401) {
        login.hidden = false;
        retry.hidden = true;
        await new Promise(resolve => {
          login.onsubmit = async event => {
            event.preventDefault();
            const button = login.querySelector('button');
            button.disabled = true; note.textContent = '';
            const fd = new FormData(login);
            try {
              await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }) });
              login.elements.password.value = ''; resolve();
            } catch (failure) { note.textContent = failure.message; }
            finally { button.disabled = false; }
          };
        });
      } else {
        login.hidden = true; retry.hidden = false; note.textContent = error.message;
        await new Promise(resolve => { retry.onclick = resolve; });
        note.textContent = '';
      }
    }
  }
  const tools = document.createElement('div');
  tools.className = 'account-tools';
  const identity = document.createElement('span'); identity.textContent = user.email;
  const saved = document.createElement('span'); saved.className = 'account-save'; saved.textContent = 'Guardado en servidor'; saved.setAttribute('role', 'status');
  const again = document.createElement('button'); again.className = 'text-btn'; again.textContent = 'Reintentar guardado'; again.hidden = true;
  const logout = document.createElement('button'); logout.className = 'btn'; logout.textContent = 'Cerrar sesión';
  tools.append(identity, saved, again, logout);
  document.querySelector('.topbar').after(tools);
  const queue = createSaveQueue({ revision: loaded.revision, transport: async (payload, revision) => request('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': `"${revision}"` }, body: payload }), status(message, state, code) {
    saved.textContent = code === 401 ? 'Sesión vencida. Exporta tus cambios antes de volver a entrar.' : message;
    saved.dataset.state = state;
    again.hidden = state !== 'error' || [401, 409].includes(code);
  } });
  again.onclick = () => queue.retry();
  logout.onclick = async () => {
    if (queue.hasUnsaved() && !confirm('Hay cambios sin guardar. Exporta una copia antes de salir. ¿Cerrar sesión de todos modos?')) return;
    try { await request('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.reload(); }
    catch (error) { saved.textContent = error.message; saved.dataset.state = 'error'; }
  };
  window.addEventListener('beforeunload', event => { if (queue.hasUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
  screen.remove(); document.body.classList.remove('auth-pending');
  return { mode: 'server', user, state: loaded.state, save: state => queue.save(state) };
}
