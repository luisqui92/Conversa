import { escapeLive } from './live-panel.mjs';

export function notificationCopy(item) {
  const network = item.channel === 'instagram' ? 'Instagram' : item.channel === 'facebook' ? 'Facebook' : 'Canal';
  const titles = { sent: 'Respuesta pública y DM enviados', public_failed: 'Respuesta pública rechazada', dm_failed: 'Respuesta enviada; DM rechazado', public_unknown: 'Respuesta pública sin confirmar', dm_unknown: 'DM sin confirmar' };
  return { title: titles[item.status] || 'Revisa la automatización', network,
    description: item.status === 'sent' ? `${network} aceptó ambos envíos.` : 'Abre el detalle para revisar el resultado.',
    tone: item.status === 'sent' ? 'success' : 'warning' };
}

export function startPanelNotifications({ onOpen, toast }) {
  const escapeNotification = escapeLive;
  const bellIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
  const host = document.createElement('div'); host.className = 'notification-host';
  host.innerHTML = `<button type="button" class="notification-bell icon-button" aria-label="Notificaciones" aria-expanded="false" aria-controls="panel-notifications">${bellIcon}<span class="notification-count" hidden aria-hidden="true"></span></button><section id="panel-notifications" class="notification-panel" aria-label="Notificaciones de Conversa" hidden><div class="notification-heading"><div><h2>Notificaciones</h2><p>Tu operación, al día.</p></div><button type="button" class="notification-close" aria-label="Cerrar notificaciones">✕</button></div><div class="notification-toolbar"><span class="notification-summary" role="status">Cargando…</span><button type="button" data-notification-all>Marcar todas como leídas</button></div><div class="notification-error" role="alert" hidden></div><div class="notification-list"></div><div class="notification-foot"><span>Últimos 7 días · hasta 30 avisos</span><button type="button" data-notification-refresh>Actualizar</button></div></section>`;
  const topbar = document.querySelector('.topbar-right'); topbar.insertBefore(host, topbar.querySelector('#help'));
  const button = host.querySelector('.notification-bell'), count = host.querySelector('.notification-count');
  const panel = host.querySelector('.notification-panel'), list = host.querySelector('.notification-list');
  const summary = host.querySelector('.notification-summary'), all = host.querySelector('[data-notification-all]');
  const errorBox = host.querySelector('.notification-error'), reload = host.querySelector('[data-notification-refresh]');
  let feed = { notifications: [], unread: 0, lastId: 0 }, initialized = false, lastSeenId = 0;
  let busy = false, mutating = false, generation = 0, sessionExpired = false;
  function position() {
    if (panel.hidden) return;
    const rect = button.getBoundingClientRect(), top = Math.max(12, Math.min(rect.bottom + 12, window.innerHeight - 220));
    panel.style.top = top + 'px';
    panel.style.right = Math.min(Math.max(12, window.innerWidth - rect.right), Math.max(12, window.innerWidth - panel.offsetWidth - 12)) + 'px';
    panel.style.maxHeight = Math.max(180, window.innerHeight - top - 16) + 'px';
  }
  function close(focus = false) { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); }
  function reportError(message) { errorBox.hidden = false; errorBox.textContent = message; button.title = message; }
  function renderFeed(next, announce = false) {
    feed = next; errorBox.hidden = true; button.title = '';
    count.hidden = !feed.unread; count.textContent = feed.unread > 99 ? '99+' : String(feed.unread);
    button.setAttribute('aria-label', `Notificaciones: ${feed.unread} sin leer`);
    summary.textContent = feed.unread ? `${feed.unread} sin leer` : 'Todo al día';
    all.disabled = !feed.unread || mutating;
    if (!feed.notifications.length) list.innerHTML = '<div class="notification-empty"><span aria-hidden="true">✓</span><strong>Sin novedades por ahora</strong><p>Los próximos resultados de tus automatizaciones aparecerán aquí.</p></div>';
    else list.innerHTML = feed.notifications.map(item => {
      const copy = notificationCopy(item), account = (item.channel === 'instagram' ? '@' : '') + item.accountName;
      const time = new Date(item.created_at).toLocaleString('es-BO', { timeZone: 'America/La_Paz', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<button type="button" class="notification-item ${item.read_at ? '' : 'unread'}" data-notification-id="${item.id}"><span class="notification-symbol ${copy.tone}" aria-hidden="true">${copy.tone === 'success' ? '✓' : '!'}</span><span class="notification-copy"><strong>${escapeNotification(copy.title)}</strong><span>${escapeNotification(copy.description)}</span><small>${escapeNotification(copy.network)}${item.accountName ? ' · ' + escapeNotification(account) : ''}</small><small>${escapeNotification(time)}</small></span>${item.read_at ? '' : '<i class="notification-unread-dot" aria-hidden="true"></i>'}</button>`;
    }).join('');
    const newer = feed.notifications.filter(n => n.id > lastSeenId && !n.read_at);
    if (announce && initialized && newer.length) toast(newer.length === 1 ? `${notificationCopy(newer[0]).network}: ${notificationCopy(newer[0]).title}.` : `${newer.length} nuevas notificaciones de automatizaciones.`);
    initialized = true; lastSeenId = Math.max(lastSeenId, feed.lastId); position();
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000), ...options });
    if (response.status === 401) { sessionExpired = true; throw new Error('Tu sesión venció. Vuelve a iniciar sesión para consultar notificaciones.'); }
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'No se pudieron consultar las notificaciones.');
    return value;
  }
  async function refresh() {
    if (busy || mutating || sessionExpired) return;
    busy = true; reload.disabled = true; const version = generation;
    try { const next = await request('/api/notifications'); if (version === generation) renderFeed(next, true); }
    catch (error) { if (version === generation) reportError(sessionExpired ? error.message : 'No se pudo actualizar. Los avisos mostrados pueden estar desactualizados.'); }
    finally { busy = false; reload.disabled = false; }
  }
  async function markRead(input) {
    const next = await request('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    renderFeed(next);
  }
  button.addEventListener('click', () => { panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); position(); if (!panel.hidden) void refresh(); });
  host.querySelector('.notification-close').addEventListener('click', () => close(true));
  reload.addEventListener('click', () => void refresh());
  all.addEventListener('click', async () => {
    if (mutating || !feed.unread || !feed.lastId) return;
    mutating = true; generation++; all.disabled = true;
    try { await markRead({ throughId: feed.lastId }); }
    catch (error) { reportError(error.message || 'No se pudieron marcar las notificaciones.'); }
    finally { mutating = false; all.disabled = !feed.unread; }
  });
  list.addEventListener('click', async event => {
    const item = event.target.closest('[data-notification-id]'); if (!item || mutating) return;
    const id = Number(item.dataset.notificationId); mutating = true; generation++; item.disabled = true;
    try {
      const detail = await request(`/api/notifications/${id}`);
      try { await markRead({ ids: [id] }); } catch { toast('Se abrió el detalle, pero no se pudo guardar la lectura.'); }
      const activity = { ...(detail.action || detail.notification), channel: detail.notification.channel };
      close(); onOpen(activity);
    } catch (error) { reportError(error.message || 'No se pudo abrir esta notificación.'); }
    finally { mutating = false; item.disabled = false; all.disabled = !feed.unread; }
  });
  document.addEventListener('click', event => { if (!host.contains(event.target)) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(true); });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
  void refresh();
}
