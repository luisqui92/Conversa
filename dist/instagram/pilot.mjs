const channel = document.documentElement.dataset.channel === 'facebook' ? 'facebook' : 'instagram';
const network = channel === 'facebook' ? 'Facebook' : 'Instagram';
const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
const content = document.querySelector('#content');
const labels = {
  pending: 'Pendiente', public_sending: 'Enviando respuesta pública', public_done: 'Respuesta aceptada; DM pendiente',
  dm_sending: 'Enviando DM', sent: 'Respuesta y DM aceptados por Instagram',
  public_failed: 'Instagram rechazó la respuesta pública', dm_failed: 'Respuesta aceptada; Instagram rechazó el DM',
  public_unknown: 'Respuesta pública sin confirmación', dm_unknown: 'DM sin confirmación',
  cancelled: 'Pendiente cancelado por pausa o cambio de regla', expired: 'Pendiente vencido'
};
function table(target, headers, rows) {
  const root = document.querySelector(target); root.replaceChildren();
  if (!rows.length) { const p = document.createElement('p'); p.textContent = target === '#rules' ? 'Todavía no hay reglas configuradas.' : 'Todavía no hay envíos registrados.'; root.append(p); return; }
  const wrap = document.createElement('div'); wrap.className = 'table-scroll';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of headers) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; head.append(th); }
  const body = table.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const value of cells) { const cell = row.insertCell(); if (value instanceof Node) cell.append(value); else cell.textContent = String(value); }
  }
  wrap.append(table); root.append(wrap);
}
async function get(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (response.status === 401) { const error = new Error('Inicia sesión en Conversa para consultar la actividad.'); error.login = true; throw error; }
  if (!response.ok) throw new Error('No se pudo consultar la actividad. Vuelve a intentar.');
  return response.json();
}
async function update() {
  if (refresh.disabled) return;
  refresh.disabled = true;
  try {
    const [account, report] = await Promise.all([get(`/api/integrations/${channel}`), get(`/api/integrations/${channel}/automation`)]);
    content.hidden = false;
    document.querySelector('#account').textContent = account.configured ? `${channel === 'instagram' ? '@' : ''}${account.username} · ${account.receivedEvents} entradas recibidas · ${account.mode === 'comment-then-dm' ? 'Automatización por publicación activada' : 'Recepción de eventos'}` : `Esta cuenta de Conversa no tiene una conexión de ${network} configurada.`;
    table('#rules', ['Publicación', 'Estado', 'Respuesta pública', 'Mensaje privado'], report.rules.map(rule => [rule.media_id, rule.enabled ? 'Activa' : 'Pausada', rule.public_text, rule.dm_text]));
    table('#actions', ['Comentario', 'Resultado', 'Actualizado'], report.actions.map(action => {
      const info = document.createElement('span'); info.textContent = (labels[action.status] || action.status).replaceAll('Instagram', network);
      if (action.last_error) { const detail = document.createElement('small'); detail.className = 'detail warning'; detail.textContent = action.last_error; info.append(detail); }
      if (action.public_id) { const detail = document.createElement('small'); detail.className = 'detail'; detail.textContent = 'Respuesta pública confirmada'; info.append(detail); }
      if (action.message_id) { const detail = document.createElement('small'); detail.className = 'detail'; detail.textContent = 'Mensaje privado confirmado'; info.append(detail); }
      return [action.comment_id, info, new Date(action.updated_at).toLocaleString('es-BO')];
    }));
    status.textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-BO');
  } catch (error) {
    content.hidden = true; status.textContent = error.login ? error.message : 'No se pudo actualizar. Comprueba la conexión y vuelve a intentar.';
    if (error.login) { const link = document.createElement('a'); link.href = '/'; link.textContent = ' Ir a iniciar sesión'; status.append(link); }
  } finally { refresh.disabled = false; }
}
refresh.addEventListener('click', update);
await update();
setInterval(() => { if (!document.hidden) void update(); }, 10_000);
