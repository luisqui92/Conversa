const liveIcon = (name) =>
  `<svg class="live-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${name === 'reply' ? '<path d="m9 5-6 6 6 6M3 11h11a6 6 0 0 1 6 6"/>' : name === 'refresh' ? '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>' : '<path d="M6 18 18 6M6 6h12v12"/>'}</svg>`;
const NETWORKS = { instagram: 'Instagram', facebook: 'Facebook' };
export const LIVE_PAGES = {
  dashboard: 'Resumen',
  activity: 'Actividad',
  automations: 'Automatizaciones',
  connections: 'Canales',
  customers: 'Clientes',
};
export const escapeLive = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const e = escapeLive;
const suffix = (value) =>
  String(value || '')
    .split('_')
    .at(-1);
const date = (value) =>
  value
    ? new Date(value).toLocaleString('es-BO', {
        timeZone: 'America/La_Paz',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Sin registro';
const mark = (channel) =>
  `<span class="live-network ${channel}" aria-hidden="true">${channel === 'facebook' ? 'f' : '◎'}</span>`;
const badge = (label, tone = 'neutral') =>
  `<span class="live-badge ${tone}"><i></i>${e(label)}</span>`;
const attentionStates = [
  'public_failed',
  'dm_failed',
  'public_unknown',
  'dm_unknown',
  'skipped_rate_limit',
  'skipped_late',
  'skipped_author',
];
const labels = {
  skipped_rate_limit: 'Omitido por límite',
  skipped_late: 'Evento fuera de plazo',
  skipped_person: 'Persona ya atendida',
  skipped_keyword: 'Sin coincidencia de palabras clave',
  skipped_author: 'Autor sin identificar',
  pending: 'En cola',
  public_sending: 'Respondiendo comentario',
  public_done: 'DM pendiente',
  dm_sending: 'Enviando DM',
  sent: 'Respuesta + DM aceptados',
  public_failed: 'Respuesta rechazada',
  dm_failed: 'DM rechazado',
  public_unknown: 'Respuesta sin confirmar',
  dm_unknown: 'DM sin confirmar',
  cancelled: 'Cancelado',
  expired: 'Vencido',
  received: 'Comentario recibido',
  incoming: 'Mensaje recibido',
};
const tone = (status) =>
  status === 'sent' ? 'success' : attentionStates.includes(status) ? 'warning' : 'neutral';

export function buildLiveActivity(channels) {
  const all = [];
  for (const [connectionKey, data] of Object.entries(channels)) {
    const channel = data.account?.channel || connectionKey;
    if (!data.account?.configured) continue;
    const comments = new Map(),
      messages = new Map();
    for (const record of data.events?.events || []) {
      const entry = record.entry;
      if (String(entry?.id) !== data.account.accountId) continue;
      for (const change of entry.changes || []) {
        const v = change.value;
        if (
          !v ||
          (channel === 'facebook'
            ? change.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add'
            : change.field !== 'comments')
        )
          continue;
        const id = channel === 'facebook' ? v.comment_id : v.id;
        const authorId = String(v.from?.id || v.sender_id || '');
        if (!id || authorId === data.account.accountId) continue;
        const key = suffix(id);
        if (comments.has(key)) continue;
        comments.set(key, {
          key: `${channel}:${data.account.accountId}:comment:${key}`,
          channel,
          connectionKey,
          accountName: data.account.username,
          kind: 'comment',
          comment_id: String(id),
          media_id: String(channel === 'facebook' ? v.post_id || '' : v.media?.id || ''),
          author: v.from?.name || v.from?.username || 'Perfil de la comunidad',
          authorId,
          text: String(channel === 'facebook' ? v.message || '' : v.text || ''),
          created_at: record.receivedAt,
          status: 'received',
        });
      }
      for (const message of entry.messaging || []) {
        if (
          !message.message ||
          message.message.is_echo ||
          String(message.sender?.id) === data.account.accountId
        )
          continue;
        const id = message.message.mid;
        if (!id || messages.has(id)) continue;
        messages.set(id, {
          key: `${channel}:${data.account.accountId}:message:${id}`,
          channel,
          connectionKey,
          accountName: data.account.username,
          kind: 'message',
          author: 'Perfil de la comunidad',
          authorId: String(message.sender?.id || ''),
          text: String(message.message.text || 'Archivo adjunto recibido'),
          created_at: message.timestamp || record.receivedAt,
          status: 'incoming',
        });
      }
    }
    for (const action of data.report?.actions || []) {
      if (action.account_id !== data.account.accountId) continue;
      const key = suffix(action.comment_id),
        source = comments.get(key);
      comments.set(key, {
        ...source,
        ...action,
        key: `${channel}:${data.account.accountId}:comment:${key}`,
        channel,
        connectionKey,
        accountName: data.account.username,
        kind: 'comment',
        author: source?.author || 'Comentario de la comunidad',
        authorId: source?.authorId || '',
        text: source?.text || '',
      });
    }
    all.push(...comments.values(), ...messages.values());
  }
  return all.sort((a, b) => b.created_at - a.created_at);
}

export function createLivePanel({ root, toast, navigate, serverMode, user = {} }) {
  let current = null,
    channels = {},
    loading = false,
    loadedAt = null,
    selected = null;
  let channelFilter = 'all',
    resultFilter = 'all',
    query = '',
    editor = null,
    saving = false,
    needsReload = false;
  let modal,
    notificationActivity = null,
    periodDays = 7,
    oauthStatus = {},
    facebookPages = [],
    customers = [],
    operationStatus = null,
    customerModal;
  const accountBase = (key) =>
    channels[key]?.account?.id
      ? '/api/channel-accounts/' + channels[key].account.id
      : '/api/integrations/' + key;
  const networkFor = (key) => channels[key]?.account?.channel || key;
  const configured = () => Object.entries(channels).filter(([, c]) => c.account?.configured);
  const rules = () =>
    configured().flatMap(([channel, c]) =>
      (c.report?.rules || []).map((rule) => ({
        ...rule,
        channel: networkFor(channel),
        connectionKey: channel,
      })),
    );
  const activities = () => buildLiveActivity(channels);
  const total = (field) =>
    configured().reduce((sum, [, c]) => sum + (c.report?.summary?.[field] || 0), 0);
  const header = (title, subtitle, buttons = '') =>
    `<div class="live-heading"><div><span class="live-eyebrow">TU CENTRO DE OPERACIONES</span><h1>${title}</h1><p>${subtitle}</p></div><div class="live-heading-actions"><span class="live-sync" role="status">${loading ? 'Actualizando…' : loadedAt ? `Actualizado ${date(loadedAt)}` : 'Conectando…'}</span><button class="btn" data-live="refresh" ${loading ? 'disabled' : ''}>${liveIcon('refresh')} Actualizar</button>${buttons}</div></div>`;
  const empty = (title, copy) =>
    `<div class="live-empty"><span aria-hidden="true">${liveIcon('arrow')}</span><h3>${title}</h3><p>${copy}</p></div>`;
  function channelCard(channel, data, expanded = false, connectionKey = channel) {
    const account = data.account,
      connected = account?.configured,
      health = account?.tokenHealth;
    return `<article class="live-channel-card"><div class="live-card-top">${mark(channel)}${badge(data.error ? 'Sin actualizar' : connected ? 'Configurado' : 'Sin configurar', data.error ? 'warning' : connected ? 'success' : 'neutral')}</div>
      <h3>${NETWORKS[channel]}</h3><p class="live-account-name">${connected ? e((channel === 'instagram' ? '@' : '') + account.username) : 'Conecta tu negocio con su comunidad'}</p>
      ${connected ? `<div class="live-channel-bottom"><span><strong>${(data.report?.rules || []).filter((r) => r.enabled).length}</strong> automatizaciones activas</span><span><strong>${account.receivedEvents}</strong> entradas · 7 días</span></div>` : '<p class="live-muted">Pulsa Conectar y autoriza tu cuenta en Meta.</p>'}
      ${expanded && connected ? `<div class="live-health ${['reconnect', 'expiring', 'unknown'].includes(health?.state) || channel === 'instagram' ? 'notice' : ''}"><strong>${channel === 'instagram' ? (health ? 'Autorización de Instagram' : 'Vigencia por comprobar') : health?.state === 'ok' ? 'Última comprobación de autorización' : 'Estado de autorización'}</strong><p>${channel === 'instagram' ? (health ? e(health.message) : 'La vigencia aún no se ha registrado. Se intentará renovar la autorización cuando sea elegible.') : e(health?.message || 'No hay una comprobación de autorización guardada.')}</p>${health?.checkedAt ? `<small>Comprobada: ${date(health.checkedAt)}</small>` : ''}${health?.expiresAt > 0 ? `<small>Token hasta: ${date(health.expiresAt * 1000)}</small>` : ''}${health?.dataAccessExpiresAt > 0 ? `<small>Acceso a datos hasta: ${date(health.dataAccessExpiresAt * 1000)}</small>` : ''}</div>` : ''}
      ${account?.maintenance?.last_error ? `<p class="live-error">${e(account.maintenance.last_error)}</p>` : ''}
      ${account?.subscriptionError ? `<p class="live-error">${e(account.subscriptionError)}</p>` : ''}
      ${expanded && connected ? `<button class="btn" data-live="connect" data-channel="${channel}">Reconectar ${NETWORKS[channel]}</button>` : ''}
      ${data.error ? '<p class="live-error">No se pudo consultar este canal. Los datos anteriores pueden estar desactualizados.</p>' : ''}
      <button class="live-link" data-live="channel" data-channel="${channel}" data-connection="${connectionKey}">Ver actividad <span>${liveIcon('arrow')}</span></button></article>`;
  }
  function overview() {
    const active = rules().filter((r) => r.enabled).length;
    return (
      header(
        'Cada conversación empieza aquí.',
        'Instagram y Facebook, conectados con tu negocio.',
      ) +
      `<section class="live-hero"><div><span class="live-hero-kicker"><i></i>COMENTARIOS QUE ABREN CONVERSACIONES</span><h2>Tu comunidad pregunta.<br>Conversa da el primer paso.</h2><p>Una respuesta pública y la información correcta por privado.<br>Tú eliges la publicación y el mensaje.</p><button class="live-hero-button" data-live="automations">Gestionar automatizaciones <span>${liveIcon('arrow')}</span></button></div><div class="live-flow-art" aria-label="Comentario, respuesta pública y mensaje privado"><div class="live-art-message"><span class="live-art-avatar">C</span><div><strong>Tu comunidad</strong><span>¡Hola! Quiero más información.</span></div><i>♡</i></div><div class="live-art-connector"></div><div class="live-art-response"><span class="live-art-avatar purple">c</span><div><strong>Tu negocio</strong><span>Te mandé la información por privado.</span><small>Respuesta pública</small></div><b>✓</b></div><div class="live-art-dm"><span>${liveIcon('arrow')}</span><div><strong>La conversación continúa</strong><small>Mensaje privado después de la respuesta</small></div></div><p>Vista ilustrativa del flujo</p></div></section>
      <div class="live-section-title"><h2>Tu operación, de un vistazo</h2><span>Últimos <select id="live-period" aria-label="Período del resumen">${[7, 30, 90].map((days) => `<option value="${days}" ${days === periodDays ? 'selected' : ''}>${days} días</option>`).join('')}</select> · ${configured().length} cuentas configuradas</span></div>
      <div class="live-metrics">${[
        ['Respuestas públicas', total('publicConfirmed'), 'Aceptadas por Meta', liveIcon('reply')],
        ['Mensajes privados', total('dmConfirmed'), 'Aceptados por Meta', liveIcon('arrow')],
        ['Requieren atención', total('attention'), 'Errores o resultados sin confirmar', '!'],
        ['Automatizaciones activas', active, 'En tus publicaciones configuradas', '✧'],
      ]
        .map(
          ([label, value, note, symbol], i) =>
            `<article class="live-metric ${i === 2 && value ? 'alert' : ''}"><span>${label}<i>${symbol}</i></span><strong>${value}</strong><small>${note}</small></article>`,
        )
        .join('')}</div>
      <div class="live-overview-grid"><section><div class="live-section-title"><h2>Tus canales</h2><button class="live-link" data-live="connections">Administrar ${liveIcon('arrow')}</button></div><div class="live-channel-grid">${(configured().length ? configured().map(([key, data]) => channelCard(networkFor(key), data, false, key)) : Object.keys(NETWORKS).map((channel) => channelCard(channel, {}))).join('')}</div></section><section class="live-process-card"><span class="live-eyebrow">ASÍ FUNCIONA</span><h2>Un flujo. Dos respuestas.</h2><ol><li><span>01</span><div><strong>Recibe un comentario</strong><p>En una publicación que hayas activado.</p></div></li><li><span>02</span><div><strong>Responde en público</strong><p>El primer paso de la automatización.</p></div></li><li><span>03</span><div><strong>Envía la información al DM</strong><p>Después de que Meta acepte la respuesta.</p></div></li></ol><small>La aceptación de Meta no confirma lectura ni notificación.</small></section></div>
      <section class="live-recent"><div class="live-section-title"><h2>Actividad reciente</h2><button class="live-link" data-live="activity">Ver toda la actividad ${liveIcon('arrow')}</button></div>${activityTable(activities().slice(0, 5))}</section>`
    );
  }
  function activityTable(items) {
    if (!items.length)
      return empty(
        'Todo empieza con un comentario.',
        'Aquí aparecerán los comentarios, mensajes y resultados recibidos por tus canales.',
      );
    return `<div class="live-table-wrap"><table class="live-table"><thead><tr><th>Conversación</th><th>Canal</th><th>Resultado</th><th>Recibido</th><th><span class="sr-only">Detalle</span></th></tr></thead><tbody>${items.map((a) => `<tr><td><strong>${e(a.author)}</strong><small>${e(a.text || 'Comentario #' + suffix(a.comment_id).slice(-6))}</small></td><td><span class="live-platform-label">${mark(a.channel)}${NETWORKS[a.channel]}</span></td><td>${badge(labels[a.status] || 'En revisión', tone(a.status))}</td><td class="live-nowrap">${date(a.created_at)}</td><td><button class="live-link" data-live="detail" data-key="${e(a.key)}" aria-label="Ver actividad de ${e(a.author)}">Ver ${liveIcon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  function filteredActivity() {
    return activities().filter(
      (a) =>
        (channelFilter === 'all' || a.channel === channelFilter) &&
        (resultFilter === 'all' ||
          (resultFilter === 'attention'
            ? attentionStates.includes(a.status)
            : a.status === resultFilter)) &&
        `${a.author} ${a.text} ${a.comment_id || ''} ${a.media_id || ''}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    );
  }
  function detail(a) {
    if (!a)
      return `<div class="live-detail-placeholder"><span>${liveIcon('arrow')}</span><h3>Abre una conversación</h3><p>Consulta el comentario, la respuesta pública y el resultado del mensaje privado.</p></div>`;
    const publicText = String(a.public_text || '').replace(
      /@\[\d+\]/g,
      a.authorId ? a.author : 'Autor del comentario',
    );
    return `<div class="live-detail-head"><span class="live-platform-label">${mark(a.channel)}${NETWORKS[a.channel]}</span>${badge(labels[a.status], tone(a.status))}</div><div class="live-detail-body"><div class="live-person"><span>${e(a.author.slice(0, 2).toUpperCase())}</span><div><h3>${e(a.author)}</h3><small>${date(a.created_at)} · Bolivia</small></div></div>${a.text ? `<p class="live-source-message">${e(a.text)}</p>` : '<p class="live-muted">El texto original no está entre las últimas entradas disponibles.</p>'}
      ${a.kind === 'comment' ? `<ol class="live-delivery"><li class="${a.public_id ? 'done' : ''}"><span>${a.public_id ? '✓' : '1'}</span><div><strong>Respuesta pública</strong><small>${a.public_id ? 'Aceptada por Meta' : a.status === 'public_failed' ? 'Rechazada por Meta' : 'Sin confirmación de envío'}</small>${publicText ? `<p>${e(publicText)}</p>` : ''}</div></li><li class="${a.message_id ? 'done' : ''}"><span>${a.message_id ? '✓' : '2'}</span><div><strong>Mensaje privado</strong><small>${a.message_id ? 'Aceptado por Meta' : a.status === 'dm_failed' ? 'Rechazado por Meta' : 'Sin confirmación de envío'}</small>${a.dm_text ? `<p>${e(a.dm_text)}</p>` : ''}</div></li></ol>` : '<div class="live-health notice"><strong>Mensaje entrante registrado</strong><p>La respuesta manual desde el panel todavía no está habilitada.</p></div>'}
      ${a.last_error ? `<div class="live-health notice"><strong>${attentionStates.includes(a.status) ? 'Requiere revisión' : 'Motivo de la omisión'}</strong><p>${e(a.last_error)}</p></div>` : ''}<p class="live-disclaimer">Los estados muestran la confirmación de la API. No confirman entrega en la bandeja principal, lectura o notificación.</p>${a.comment_id ? `<details class="live-identifiers"><summary>Identificadores de la actividad</summary><p>Comentario: ${e(a.comment_id)}</p><p>Publicación: ${e(a.media_id)}</p>${a.public_id ? `<p>Respuesta: ${e(a.public_id)}</p>` : ''}</details>` : ''}</div>`;
  }
  function activityPage() {
    const items = filteredActivity(),
      active =
        activities().find((a) => a.key === selected) ||
        (notificationActivity?.key === selected ? notificationActivity : null);
    return (
      header(
        'Tu actividad, en un solo lugar.',
        'Comentarios, mensajes y resultados de tus conexiones reales.',
      ) +
      `<div class="live-filters"><label class="live-search"><span aria-hidden="true">⌕</span><input type="search" id="live-search" aria-label="Buscar actividad" placeholder="Buscar persona, comentario o publicación…" value="${e(query)}"></label><select id="live-channel-filter" aria-label="Filtrar canal"><option value="all">Todos los canales</option>${Object.entries(
        NETWORKS,
      )
        .map(
          ([id, label]) =>
            `<option value="${id}" ${id === channelFilter ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select><select id="live-result-filter" aria-label="Filtrar resultado">${[
        ['all', 'Todos los resultados'],
        ['sent', 'Respuesta + DM aceptados'],
        ['attention', 'Requieren atención'],
        ['incoming', 'Mensajes entrantes'],
      ]
        .map(
          ([id, label]) =>
            `<option value="${id}" ${resultFilter === id ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select></div>
      <div class="live-activity-layout"><section class="live-activity-list"><div class="live-list-title"><h2>Conversaciones</h2><span>${items.length} registros disponibles</span></div><div id="live-results">${activityTable(items)}</div></section><aside class="live-detail" aria-label="Detalle de la actividad">${detail(active)}</aside></div><p class="live-disclaimer">Se consultan las últimas 50 entradas y 50 automatizaciones por cuenta. El resumen permite consultar 7, 30 o 90 días de envíos conservados.</p>`
    );
  }
  function automationPage() {
    const items = rules();
    return (
      header(
        'El mensaje correcto, en cada post.',
        'Configura lo que recibe una persona cuando comenta tu publicación.',
        '<button class="btn primary" data-live="new-rule">＋ Nueva automatización</button>',
      ) +
      `<div class="live-info"><span>${liveIcon('arrow')}</span><div><strong>Primero una respuesta pública. Después, un mensaje privado.</strong><p>Se aplica a comentarios nuevos de otras cuentas en las publicaciones activas. Límite actual: 30 flujos nuevos por hora y cuenta. Las omisiones quedan registradas.</p></div></div><div class="live-rule-grid">${items.length ? items.map((r) => `<article class="live-rule-card"><div class="live-card-top"><span class="live-platform-label">${mark(r.channel)}${NETWORKS[r.channel]}</span>${badge(r.enabled ? 'Activa' : 'Pausada', r.enabled ? 'success' : 'neutral')}</div><h2>Publicación #${e(suffix(r.media_id).slice(-6))}</h2><p class="live-rule-account">${e(channels[r.connectionKey].account.username)}</p><div class="live-rule-preview"><div><span>01 · RESPUESTA PÚBLICA</span><p>${e(r.public_text)}</p></div><div><span>02 · MENSAJE PRIVADO</span><p>${e(r.dm_text)}</p></div></div><div class="live-rule-footer"><button class="btn" data-live="edit-rule" data-channel="${r.channel}" data-connection="${r.connectionKey}" data-media="${e(r.media_id)}">Editar mensajes</button><button class="live-link ${r.enabled ? 'pause' : ''}" data-live="toggle-rule" data-channel="${r.channel}" data-connection="${r.connectionKey}" data-media="${e(r.media_id)}">${r.enabled ? 'Ⅱ Pausar' : '▷ Activar'}</button></div><details class="live-identifiers"><summary>ID de publicación</summary><p>${e(r.media_id)}</p></details></article>`).join('') : empty('Tu primera automatización.', 'Vincula un canal y configura el ID de una publicación para empezar.')}</div><p class="live-disclaimer">Al guardar cambios o reactivar una regla, solo se procesan comentarios nuevos. Los pendientes de la configuración anterior se cancelan. Los fallidos no se reenvían. Una solicitud que ya esté en curso puede terminar después de pausar.</p>`
    );
  }
  function connectionsPage() {
    return (
      header(
        'Tus canales. Tu comunidad.',
        'Cada cuenta conectada pertenece a tu negocio.',
        Object.keys(NETWORKS)
          .map(
            (channel) =>
              `<button class="btn primary" data-live="connect" data-channel="${channel}" ${oauthStatus[channel] === false ? 'disabled' : ''}>＋ Conectar ${NETWORKS[channel]}</button>`,
          )
          .join(''),
      ) +
      (facebookPages.length
        ? `<section class="live-info"><div><h2>Elige las páginas para este negocio</h2><p>Conecta únicamente las páginas que gestionarás desde esta cuenta de Conversa.</p>${facebookPages.map((p) => `<div class="live-page-choice"><strong>${e(p.name)}</strong><button class="btn" data-live="connect-page" data-page-id="${e(p.id)}">Conectar página</button></div>`).join('')}</div></section>`
        : '') +
      `<div class="live-connections">${(configured().length ? configured().map(([key, data]) => channelCard(networkFor(key), data, true, key)) : Object.keys(NETWORKS).map((channel) => channelCard(channel, {}, true))).join('')}</div><section class="live-connection-note"><span>${liveIcon('arrow')}</span><div><h2>Tus cuentas se autorizan con Meta.</h2><p>Inicia sesión en Instagram o Facebook para conceder acceso a Conversa. Tus contraseñas de las redes no se introducen aquí. Los permisos disponibles dependen de la aprobación de la aplicación por Meta.</p><button class="btn" data-live="automations">Ver automatizaciones ${liveIcon('arrow')}</button></div></section>`
    );
  }
  function customersPage() {
    if (!user.admin)
      return empty(
        'Acceso reservado.',
        'Solo el administrador de Conversa gestiona el alta de clientes.',
      );
    const connected = customers.reduce((n, c) => n + c.accounts, 0);
    return (
      header(
        'Tus clientes, cada uno en su espacio.',
        'Los clientes tienen su propio acceso, cuentas sociales y actividad.',
        '<button class="btn primary" data-live="new-customer">＋ Crear cliente</button>',
      ) +
      `<div class="live-metrics admin-metrics">${[
        ['Negocios registrados', customers.length, 'Accesos separados por cliente'],
        ['Cuentas vinculadas', connected, 'Instagram y Facebook'],
        [
          'Pendientes de conexión',
          customers.filter((c) => !c.accounts).length,
          'El cliente autoriza sus redes con Meta',
        ],
      ]
        .map(
          ([label, value, note]) =>
            `<article class="live-metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`,
        )
        .join(
          '',
        )}</div><div class="live-section-title"><h2>Negocios</h2><span>Crear acceso → conectar canales → activar publicaciones</span></div>
      <div class="live-table-wrap"><table class="live-table"><thead><tr><th>Negocio</th><th>Correo de acceso</th><th>Cuentas conectadas</th><th>Estado</th></tr></thead><tbody>${customers.map((c) => `<tr><td><strong>${e(c.name)}</strong></td><td>${e(c.email)}</td><td>${c.accounts}</td><td>${c.invitationPending ? `<button class="btn" data-invite-owner="${e(c.owner_id)}">Renovar invitación</button>` : badge(c.accounts ? 'Canales configurados' : 'Pendiente de conexión', c.accounts ? 'success' : 'neutral')}</td></tr>`).join('')}</tbody></table></div>
      <div class="live-health notice">
        <strong>${operationStatus?.externalBackupConfigured ? 'Copia externa reciente' : 'Respaldo externo pendiente de revisión'}</strong>
        <p>${operationStatus?.backup?.lastSuccess ? 'Última copia completada: ' + date(operationStatus.backup.lastSuccess) + '. ' : ''}La base se respalda en un bucket privado y la llave se recupera por separado desde Secret Manager. Comprueba y registra también una restauración aislada.</p>
        ${operationStatus?.backup?.error ? `<p>${e(operationStatus.backup.error)}</p>` : ''}
      </div>
      ${operationStatus?.workers?.length ? `<section class="live-process-card"><h2>Estado de los procesos</h2>${operationStatus.workers.map((w) => `<p>${e(NETWORKS[w.channel])} · Última actividad: ${date(w.lastTick)}${w.lastError ? ' · Último error interno: ' + date(w.lastError) : ''}</p>`).join('')}</section>` : ''}`
    );
  }
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-invite-owner]');
    if (!button || !user.admin) return;
    button.disabled = true;
    try {
      const result = await request(
        '/api/admin/customers/' + button.dataset.inviteOwner + '/invitation',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      showInvitation(result.invitation);
    } catch (error) {
      toast(error.message || 'No se pudo renovar la invitación.');
    } finally {
      button.disabled = false;
    }
  });
  async function openCustomer() {
    if (!user.admin) return;
    customerModal?.remove();
    customerModal = document.createElement('dialog');
    customerModal.className = 'live-editor';
    customerModal.setAttribute('aria-label', 'Crear cliente');
    customerModal.innerHTML = `
      <form>
        <div class="live-editor-head">
          <h2>Crear cliente</h2>
          <button type="button" class="icon-button" data-customer-close aria-label="Cerrar">✕</button>
        </div>
        <label class="field">Nombre del negocio
          <input name="name" required maxlength="100" autocomplete="organization">
        </label>
        <label class="field">Correo de acceso
          <input name="email" type="email" required maxlength="254" autocomplete="off">
        </label>
        <p>El cliente elegirá su contraseña mediante un enlace privado de un solo uso.</p>
        <p role="alert" class="live-form-error"></p>
        <div class="live-editor-actions">
          <button type="button" class="btn" data-customer-close>Cancelar</button>
          <button class="btn primary" type="submit">Crear invitación</button>
        </div>
      </form>`;
    document.body.append(customerModal);
    customerModal.addEventListener('click', (event) => {
      if (event.target.closest('[data-customer-close]')) customerModal.close();
    });
    customerModal.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target,
        fd = new FormData(form),
        submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const created = await request('/api/admin/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(fd)),
        });
        form.reset();
        customerModal.close();
        showInvitation(created.invitation);
        await refresh();
      } catch (error) {
        form.querySelector('[role="alert"]').textContent =
          error.message || 'No se pudo crear el cliente.';
      } finally {
        submit.disabled = false;
      }
    });
    customerModal.showModal();
  }
  function showInvitation(invitation) {
    const dialog = document.createElement('dialog');
    dialog.className = 'live-editor';
    dialog.setAttribute('aria-label', 'Invitación del cliente');
    dialog.innerHTML = `
      <h2>El acceso está listo para activar.</h2>
      <p>Comparte este enlace en privado con el cliente. Caduca en 24 horas y solo se puede usar una vez.</p>
      <label class="field">Enlace de invitación<input readonly aria-label="Enlace de invitación"></label>
      <p>No se envió ningún correo automáticamente. El cliente elegirá su contraseña al abrir el enlace.</p>
      <div class="live-editor-actions">
        <button class="btn" data-copy>Copiar enlace</button>
        <button class="btn primary" data-close>Cerrar</button>
      </div>`;
    const link = dialog.querySelector('input');
    link.value = invitation.url;
    dialog.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link.value);
        toast('Enlace copiado. Compártelo por un medio privado.');
      } catch {
        link.select();
        toast('Selecciona y copia el enlace.');
      }
    });
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      link.value = '';
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  function render() {
    if (!current) return;
    if (!serverMode) {
      root.innerHTML =
        header(
          'Tu centro de operaciones.',
          'La actividad real necesita una sesión en el servidor de Conversa.',
        ) +
        empty(
          'Abre tu panel en línea.',
          'Inicia sesión en cc.chatgo.ia.bo para consultar tus conexiones. La demo sigue disponible en el menú.',
        );
      return;
    }
    if (!loadedAt && loading) {
      root.innerHTML =
        header('Tu negocio, conectado.', 'Preparando tu centro de operaciones…') +
        '<div class="live-loading" role="status"><span></span>Cargando tus canales y su actividad real…</div>';
      return;
    }
    root.innerHTML =
      (needsReload
        ? '<div class="live-error-banner" role="alert">Tu sesión venció. <a href="/">Volver a iniciar sesión ↗</a></div>'
        : '') +
      (Object.values(channels).some((c) => c.error)
        ? '<div class="live-error-banner" role="alert">Hay canales que no se pudieron actualizar. Reintenta para consultar su estado actual.</div>'
        : '') +
      {
        dashboard: overview,
        activity: activityPage,
        automations: automationPage,
        connections: connectionsPage,
        customers: customersPage,
      }[current]();
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      ...options,
    });
    if (response.status === 401) {
      needsReload = true;
      throw new Error('Tu sesión venció. Vuelve a iniciar sesión.');
    }
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error || 'No se pudo completar la operación.'), {
        status: response.status,
      });
    return value;
  }
  async function refresh() {
    if (!serverMode || loading || saving) return;
    loading = true;
    render();
    try {
      const catalogue = await request('/api/channel-accounts');
      const next = {};
      await Promise.all(
        catalogue.accounts.map(async (account) => {
          const key = account.id;
          try {
            const [report, events] = await Promise.all([
              request('/api/channel-accounts/' + key + '/automation?days=' + periodDays),
              request('/api/channel-accounts/' + key + '/events'),
            ]);
            next[key] = { account, report, events };
          } catch {
            next[key] = { ...channels[key], account, error: true };
          }
        }),
      );
      channels = next;
      const context = document.querySelector('.live-account-context strong');
      if (context && catalogue.business) context.textContent = catalogue.business.name;
      try {
        oauthStatus = await request('/api/oauth/status');
        facebookPages = (await request('/api/oauth/facebook/pages')).pages || [];
      } catch {
        /* Accounts remain usable if OAuth is not configured. */
      }
      if (user.admin) {
        customers = (await request('/api/admin/customers')).customers;
        operationStatus = await request('/api/admin/operations');
      }
    } catch (error) {
      for (const key of Object.keys(channels)) channels[key].error = true;
      if (!Object.keys(channels).length) channels = { unavailable: { error: true } };
    }
    loading = false;
    loadedAt = Date.now();
    render();
  }
  function closeEditor() {
    if (saving) return;
    modal?.close();
    editor = null;
  }
  function openEditor(rule = null) {
    if (loading) return;
    const accounts = configured();
    if (!accounts.length) {
      toast('Conecta primero una cuenta desde Canales.');
      return;
    }
    editor = rule || {
      connectionKey: accounts[0][0],
      channel: networkFor(accounts[0][0]),
      media_id: '',
      public_text: '',
      dm_text: '',
      enabled: 1,
      version: null,
    };
    if (!modal) {
      modal = document.createElement('dialog');
      modal.className = 'live-editor';
      modal.setAttribute('aria-labelledby', 'live-editor-title');
      document.body.append(modal);
      modal.addEventListener('cancel', (event) => {
        if (saving) event.preventDefault();
        else editor = null;
      });
      modal.addEventListener('click', (event) => {
        if (event.target.closest('[data-editor-close]')) closeEditor();
      });
      modal.addEventListener('input', previewEditor);
      modal.addEventListener('change', previewEditor);
      modal.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (saving) return;
        const fd = new FormData(event.target),
          connectionKey = String(fd.get('channel') || editor.connectionKey),
          channel = networkFor(connectionKey);
        const input = {
          mediaId: String(fd.get('mediaId')).trim(),
          publicText: String(fd.get('publicText')).trim(),
          dmText: String(fd.get('dmText')).trim(),
          enabled: Boolean(editor.enabled),
          expectedVersion: editor.version,
          keywords: String(fd.get('keywords') || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          cooldownSeconds: Number(fd.get('cooldown')) * 3600,
        };
        saving = true;
        modal
          .querySelectorAll('button,input,textarea,select')
          .forEach((el) => (el.disabled = true));
        try {
          const report = await request(accountBase(connectionKey) + '/automation', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          });
          channels[connectionKey].report = report;
          channels[connectionKey].account.mode = report.rules.some((r) => r.enabled)
            ? 'comment-then-dm'
            : 'receive-only';
          modal.close();
          editor = null;
          toast(
            input.enabled
              ? 'Automatización guardada para comentarios nuevos.'
              : 'Mensajes guardados. La automatización sigue pausada.',
          );
          render();
        } catch (error) {
          modal.querySelector('[role="alert"]').textContent =
            error.message || 'No se pudo guardar. Vuelve a intentar.';
        } finally {
          saving = false;
          modal
            .querySelectorAll('button,input,textarea,select')
            .forEach((el) => (el.disabled = false));
          if (editor?.version) modal.querySelector('[name="channel"]').disabled = true;
        }
      });
    }
    modal.innerHTML = `<form><div class="live-editor-head"><div><span class="live-eyebrow">COMENTARIO → MENSAJE PRIVADO</span><h2 id="live-editor-title">${rule ? 'Editar automatización' : 'Nueva automatización'}</h2></div><button type="button" class="icon-button" data-editor-close aria-label="Cerrar">✕</button></div><label class="field">Canal<select name="channel" ${rule ? 'disabled' : ''}>${accounts.map(([channel, c]) => `<option value="${channel}" ${channel === editor.connectionKey ? 'selected' : ''}>${NETWORKS[networkFor(channel)]} · ${e(c.account.username)}</option>`).join('')}</select></label><label class="field">ID de la publicación<input name="mediaId" value="${e(editor.media_id)}" ${rule ? 'readonly' : ''} required maxlength="92" pattern="[0-9]+(_[0-9]+){0,2}" placeholder="Pega el ID de la publicación"><small>Usa el ID de Meta, no el enlace. ${rule ? 'Para otra publicación, crea una automatización nueva.' : 'Facebook: ID de página_ID de publicación. Instagram: ID del contenido.'}</small></label><label class="field">01 · Respuesta pública<textarea name="publicText" required maxlength="1000" placeholder="Te mandé la información por privado.">${e(editor.public_text)}</textarea><small id="live-author-hint">En Facebook puedes usar {autor} para mencionar al autor del comentario.</small></label><label class="field">02 · Mensaje privado<textarea name="dmText" required maxlength="1000" placeholder="¡Hola! Aquí tienes la información…">${e(editor.dm_text)}</textarea></label><label class="field">Palabras clave, separadas por comas<input name="keywords" value="${e(JSON.parse(editor.keywords || '[]').join(', '))}" maxlength="1200" placeholder="precio, información, visita"><small>Déjalo vacío para responder a cualquier comentario elegible.</small></label><label class="field">Intervalo por persona y publicación (horas)<input name="cooldown" type="number" min="0" max="720" required value="${(editor.cooldown_seconds ?? 86400) / 3600}" step="1"><small>24 horas evita repetir el DM a la misma persona en el mismo post. 0 desactiva este control.</small></label><div class="live-editor-preview"><span>VISTA PREVIA</span><p id="live-public-preview"></p><span>DESPUÉS, POR PRIVADO</span><p id="live-dm-preview"></p></div><p class="live-disclaimer">${editor.enabled ? 'Al guardar, responderá a comentarios nuevos en esta publicación.' : 'La automatización se mantendrá pausada.'} El DM se solicita después de confirmar la respuesta pública.</p><p class="live-form-error" role="alert"></p><div class="live-editor-actions"><button type="button" class="btn" data-editor-close>Cancelar</button><button type="submit" class="btn primary">${rule ? 'Guardar cambios' : 'Guardar y activar'}</button></div></form>`;
    previewEditor();
    modal.showModal();
  }
  function previewEditor() {
    if (!modal || !editor) return;
    const form = modal.querySelector('form'),
      channel = networkFor(form.elements.channel.value);
    modal.querySelector('#live-public-preview').textContent =
      form.elements.publicText.value.replaceAll(
        '{autor}',
        channel === 'facebook' ? 'Nombre del autor' : '{autor}',
      ) || 'Tu respuesta pública aparecerá aquí.';
    modal.querySelector('#live-dm-preview').textContent =
      form.elements.dmText.value || 'Tu mensaje privado aparecerá aquí.';
    modal.querySelector('#live-author-hint').hidden = channel !== 'facebook';
  }
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-live]');
    if (!button) return;
    const action = button.dataset.live;
    if (action === 'new-customer') return void openCustomer();
    if (action === 'connect') {
      button.disabled = true;
      try {
        const result = await request('/api/oauth/' + button.dataset.channel + '/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const target = new URL(result.url);
        if (
          target.protocol !== 'https:' ||
          !['www.facebook.com', 'www.instagram.com'].includes(target.hostname)
        )
          throw new Error('Destino de autorización no válido.');
        location.assign(target.href);
      } catch (error) {
        toast(error.message || 'No se pudo iniciar la conexión.');
        button.disabled = false;
      }
      return;
    }
    if (action === 'connect-page') {
      button.disabled = true;
      try {
        const result = await request('/api/oauth/facebook/connect-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageId: button.dataset.pageId }),
        });
        toast(result.warning || 'Página conectada a tu negocio.');
        await refresh();
      } catch (error) {
        toast(error.message || 'No se pudo conectar la página.');
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'refresh') return void refresh();
    if (LIVE_PAGES[action]) return navigate(action);
    if (action === 'channel') {
      channelFilter = button.dataset.channel;
      resultFilter = 'all';
      query = '';
      selected = null;
      navigate('activity');
    }
    if (action === 'detail') {
      selected = button.dataset.key;
      if (current !== 'activity') navigate('activity');
      else render();
      root.querySelector('.live-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (action === 'new-rule') openEditor();
    if (action === 'edit-rule')
      openEditor(
        rules().find(
          (r) =>
            r.connectionKey === button.dataset.connection && r.media_id === button.dataset.media,
        ),
      );
    if (action === 'toggle-rule') {
      if (saving) return;
      const rule = rules().find(
        (r) => r.connectionKey === button.dataset.connection && r.media_id === button.dataset.media,
      );
      if (!rule) return;
      saving = true;
      button.disabled = true;
      try {
        channels[rule.connectionKey].report = await request(
          accountBase(rule.connectionKey) + '/automation',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mediaId: rule.media_id,
              publicText: rule.public_text,
              dmText: rule.dm_text,
              enabled: !rule.enabled,
              expectedVersion: rule.version,
              keywords: JSON.parse(rule.keywords || '[]'),
              cooldownSeconds: rule.cooldown_seconds ?? 86400,
            }),
          },
        );
        toast(
          rule.enabled
            ? 'Automatización pausada. Una solicitud en curso puede terminar.'
            : 'Automatización activada para comentarios nuevos.',
        );
        render();
      } catch (error) {
        toast(error.message || 'No se pudo actualizar.');
      } finally {
        saving = false;
        button.disabled = false;
      }
    }
  });
  root.addEventListener('input', (event) => {
    if (event.target.id !== 'live-search') return;
    query = event.target.value;
    root.querySelector('#live-results').innerHTML = activityTable(filteredActivity());
    root.querySelector('.live-list-title span').textContent =
      `${filteredActivity().length} registros disponibles`;
  });
  root.addEventListener('change', (event) => {
    if (event.target.id === 'live-period') {
      periodDays = Number(event.target.value);
      void refresh();
      return;
    }
    if (event.target.id === 'live-channel-filter') {
      channelFilter = event.target.value;
      selected = null;
      render();
    }
    if (event.target.id === 'live-result-filter') {
      resultFilter = event.target.value;
      selected = null;
      render();
    }
  });
  setInterval(() => {
    if (
      current &&
      !document.hidden &&
      !modal?.open &&
      !root.querySelector('input:focus,select:focus,textarea:focus')
    )
      void refresh();
  }, 15_000);
  const oauthResult = new URL(location.href).searchParams.get('oauth');
  if (oauthResult) {
    const messages = {
      connected: 'Cuenta conectada a tu negocio.',
      'choose-facebook': 'Elige la página que quieres conectar en Canales.',
      denied: 'No se concedió la autorización. Puedes intentarlo nuevamente.',
      error: 'Meta no pudo completar la conexión. Revisa permisos y aprobación de la aplicación.',
      'account-in-use': 'Esa cuenta ya está conectada a otro negocio.',
      'subscription-pending': 'Cuenta guardada. Reconecta para completar la recepción de eventos.',
    };
    setTimeout(() => toast(messages[oauthResult] || 'Revisa el estado de conexión.'), 0);
    const clean = new URL(location.href);
    clean.searchParams.delete('oauth');
    clean.searchParams.delete('channel');
    history.replaceState(null, '', clean);
  }
  return {
    openActivity(item) {
      selected = `${item.channel}:${item.account_id}:comment:${suffix(item.comment_id)}`;
      notificationActivity = {
        ...item,
        key: selected,
        kind: 'comment',
        author: 'Comentario de la comunidad',
        authorId: '',
        text: '',
      };
      channelFilter = item.channel;
      resultFilter = 'all';
      query = '';
      navigate('activity');
      void refresh();
    },
    mount(page) {
      current = LIVE_PAGES[page] ? page : null;
      if (current) {
        render();
        if (!loadedAt) void refresh();
      }
    },
  };
}
