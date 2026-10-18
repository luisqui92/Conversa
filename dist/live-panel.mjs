import {
  buildPublications,
  publicationCard,
  conversationDetail,
  networkMark,
  initials,
  needsAttention,
} from './publications.mjs';
const liveIcon = (name) =>
  `<svg class="live-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${name === 'reply' ? '<path d="m9 5-6 6 6 6M3 11h11a6 6 0 0 1 6 6"/>' : name === 'refresh' ? '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>' : '<path d="M6 18 18 6M6 6h12v12"/>'}</svg>`;
const NETWORKS = { instagram: 'Instagram', facebook: 'Facebook' };
export const LIVE_PAGES = {
  dashboard: 'Publicaciones',
  activity: 'Conversaciones',
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
          media_id: String(
            channel === 'facebook' ? v.post_id || v.post?.id || '' : v.media?.id || '',
          ),
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
        authorId: source?.authorId || action.author_id || '',
        text: source?.text || '',
      });
    }
    for (const message of messages.values()) {
      const person = [...comments.values()].find(
        (comment) => comment.authorId && comment.authorId === message.authorId,
      );
      if (person) message.author = person.author;
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
    customerModal,
    postTab = 'active',
    postQuery = '',
    postChannel = 'all',
    selectedPost = null,
    threadClosed = false;
  const metadataLoading = new Set();
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
  const publications = () => buildPublications(channels, activities());
  function overview() {
    const all = publications();
    const posts = all.filter(
      (p) =>
        p.state === postTab &&
        (postChannel === 'all' || p.channel === postChannel) &&
        `${p.title} ${p.caption} ${p.accountName} ${p.items.map((a) => a.author + ' ' + a.text).join(' ')}`
          .toLocaleLowerCase()
          .includes(postQuery.toLocaleLowerCase()),
    );
    const activePost = posts.find((p) => p.key === selectedPost) || posts[0];
    const active = activePost?.items.find((a) => a.key === selected) || activePost?.items[0];
    const showThread = activePost && !threadClosed;
    return `<div class="publications-heading">
      <div>
      <span class="post-kicker">TU ESPACIO DE TRABAJO</span>
      <h1>Tus publicaciones</h1>
      <p>Cada consulta empieza con una publicación.</p>
      </div>
      <button class="btn primary" data-live="new-rule">
      <span aria-hidden="true">＋</span> Activar publicación</button>
      </div>
      <div class="publication-tools">
      <div class="post-tabs" role="tablist" aria-label="Estado de las publicaciones">${[
        ['active', 'Activas'],
        ['paused', 'Pausadas'],
        ['available', 'Sin activar'],
      ]
        .map(
          ([id, label]) =>
            `<button role="tab" id="publication-tab-${id}" aria-controls="publication-results" tabindex="${postTab === id ? 0 : -1}" aria-selected="${postTab === id}" data-live="post-tab" data-tab="${id}">${label}</button>`,
        )
        .join('')}</div>
      <div class="post-filters">
      <label class="post-search">
      <span aria-hidden="true">⌕</span>
      <input type="search" id="post-search" aria-label="Buscar publicaciones" placeholder="Buscar publicación o persona" value="${e(postQuery)}">
      </label>
      <select id="post-channel" aria-label="Canal de las publicaciones">
      <option value="all">Todos los canales</option>${Object.entries(NETWORKS)
        .map(
          ([id, label]) =>
            `<option value="${id}" ${postChannel === id ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select>
      <button class="icon-button" data-live="refresh" aria-label="Actualizar publicaciones" ${loading ? 'disabled' : ''}>${liveIcon('refresh')}</button>
      </div>
      </div>
      <div class="publications-workspace ${showThread ? 'with-thread' : ''}">
      <section class="publication-list" id="publication-results" role="tabpanel" aria-labelledby="publication-tab-${postTab}" aria-label="Publicaciones ${postTab === 'active' ? 'activas' : postTab === 'paused' ? 'pausadas' : 'sin activar'}">${
        posts.length
          ? posts.map((p) => publicationCard(p, showThread ? activePost.key : null)).join('')
          : `<div class="publications-empty">
      <span aria-hidden="true">${liveIcon('reply')}</span>
      <h2>${postQuery || postChannel !== 'all' ? 'No encontramos esa publicación.' : postTab === 'paused' ? 'No tienes publicaciones pausadas.' : postTab === 'available' ? 'Trae tus publicaciones a Conversa.' : 'Tu próxima conversación empieza aquí.'}</h2>
      <p>${postTab === 'paused' ? 'Las publicaciones que pauses aparecerán en este espacio.' : postTab === 'available' ? 'Aquí se muestran las últimas publicaciones accesibles de tus cuentas. También puedes activar una publicación anterior con su ID.' : 'Elige una publicación, prepara la respuesta y deja que Conversa dé el primer paso.'}</p>
      <button class="btn primary" data-live="${configured().length ? 'new-rule' : 'connections'}">${configured().length ? 'Activar publicación' : 'Conectar un canal'}</button>
      </div>`
      }<div class="post-list-foot">
      <span class="post-sync">${loading ? 'Actualizando…' : loadedAt ? 'Actualizado ' + date(loadedAt) : 'Conectando…'}</span>${Object.values(channels).some((c) => c.publications?.unavailable) ? '<span>Algunas fotos o publicaciones no están disponibles. Tus automatizaciones se conservan.</span>' : ''}<span>Comentarios disponibles: últimos 7 días. Envíos: <select id="live-period" aria-label="Período de los envíos">${[7, 30, 90].map((d) => `<option value="${d}" ${d === periodDays ? 'selected' : ''}>${d} días</option>`).join('')}</select>.</span>
      </div>
      </section>${showThread ? `<aside class="conversation-thread" aria-label="Conversación de la publicación">${conversationDetail(active, activePost)}</aside>` : ''}</div>`;
  }
  function activityTable(items) {
    if (!items.length)
      return empty(
        'Todavía no hay conversaciones aquí.',
        'Los comentarios y mensajes de tus canales aparecerán en este espacio.',
      );
    return `<div class="conversation-rows">${items
      .map(
        (
          a,
        ) => `<button class="conversation-row ${selected === a.key ? 'selected' : ''}" data-live="detail" data-key="${e(a.key)}">
      <span class="person-initials">${e(initials(a.author))}</span>
      <span class="conversation-row-copy">
      <strong>${e(a.author)}</strong>
      <span>${e(a.text || 'Ver resultado del comentario')}</span>
      <small>${networkMark(a.channel)}${e(a.accountName || NETWORKS[a.channel])} · ${a.kind === 'message' ? 'Mensaje entrante' : 'Comentario'}</small>
      </span>
      <span class="conversation-row-meta">
      <time>${date(a.created_at)}</time>${badge(labels[a.status] || 'En revisión', tone(a.status))}</span>
      <span aria-hidden="true">↗</span>
      </button>`,
      )
      .join('')}</div>`;
  }
  function filteredActivity() {
    return activities().filter(
      (a) =>
        (channelFilter === 'all' || a.channel === channelFilter) &&
        (resultFilter === 'all' ||
          (resultFilter === 'attention' ? needsAttention(a) : a.status === resultFilter)) &&
        `${a.author} ${a.text} ${a.comment_id || ''} ${a.media_id || ''}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    );
  }
  function detail(a) {
    const post = a
      ? publications().find((p) => p.connectionKey === a.connectionKey && p.id === a.media_id)
      : null;
    const account = a ? channels[a.connectionKey]?.account || {} : {};
    return conversationDetail(a, post, account);
  }
  function activityPage() {
    const items = filteredActivity(),
      active = !threadClosed
        ? items.find((a) => a.key === selected) ||
          (notificationActivity?.key === selected ? notificationActivity : null) ||
          items[0]
        : null;
    return (
      header(
        'Tus conversaciones',
        'Quién preguntó, qué respondió Conversa y qué necesita tu atención.',
      ) +
      `<div class="live-filters">
      <label class="live-search">
      <span aria-hidden="true">⌕</span>
      <input type="search" id="live-search" aria-label="Buscar actividad" placeholder="Buscar persona, comentario o publicación…" value="${e(query)}">
      </label>
      <select id="live-channel-filter" aria-label="Filtrar canal">
      <option value="all">Todos los canales</option>${Object.entries(NETWORKS)
        .map(
          ([id, label]) =>
            `<option value="${id}" ${id === channelFilter ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select>
      <select id="live-result-filter" aria-label="Filtrar resultado">${[
        ['all', 'Todos los resultados'],
        ['sent', 'Respuesta + DM aceptados'],
        ['attention', 'Requieren atención'],
        ['incoming', 'Mensajes entrantes'],
      ]
        .map(
          ([id, label]) =>
            `<option value="${id}" ${resultFilter === id ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select>
      </div>
      <div class="live-activity-layout ${threadClosed ? 'thread-closed' : ''}">
      <section class="live-activity-list">
      <div class="live-list-title">
      <h2>Conversaciones</h2>
      <span>${items.length} registros disponibles</span>
      </div>
      <div id="live-results">${activityTable(items)}</div>
      </section>${!threadClosed ? `<aside class="live-detail conversation-thread" aria-label="Detalle de la actividad">${detail(active)}</aside>` : ''}</div>
      <p class="live-disclaimer">Se consultan las últimas 50 entradas y 50 automatizaciones por cuenta. El resumen permite consultar 7, 30 o 90 días de envíos conservados.</p>`
    );
  }
  function automationPage() {
    const items = rules(),
      posts = publications();
    return (
      header(
        'El mensaje correcto, en cada post.',
        'Configura lo que recibe una persona cuando comenta tu publicación.',
        '<button class="btn primary" data-live="new-rule">＋ Nueva automatización</button>',
      ) +
      `<div class="live-info"><span>${liveIcon('arrow')}</span><div><strong>Primero una respuesta pública. Después, un mensaje privado.</strong><p>Se aplica a comentarios nuevos de otras cuentas en las publicaciones activas. Límite actual: 30 flujos nuevos por hora y cuenta. Las omisiones quedan registradas.</p></div></div><div class="live-rule-grid">${items.length ? items.map((r) => `<article class="live-rule-card"><div class="live-card-top"><span class="live-platform-label">${mark(r.channel)}${NETWORKS[r.channel]}</span>${badge(r.enabled ? 'Activa' : 'Pausada', r.enabled ? 'success' : 'neutral')}</div><h2>${e(posts.find((p) => p.connectionKey === r.connectionKey && p.id === r.media_id)?.title || 'Publicación #' + suffix(r.media_id).slice(-6))}</h2><p class="live-rule-account">${e(channels[r.connectionKey].account.username)}</p><div class="live-rule-preview"><div><span>01 · RESPUESTA PÚBLICA</span><p>${e(r.public_text)}</p></div><div><span>02 · MENSAJE PRIVADO</span><p>${e(r.dm_text)}</p></div></div><div class="live-rule-footer"><button class="btn" data-live="edit-rule" data-channel="${r.channel}" data-connection="${r.connectionKey}" data-media="${e(r.media_id)}">Editar mensajes</button><button class="live-link ${r.enabled ? 'pause' : ''}" data-live="toggle-rule" data-channel="${r.channel}" data-connection="${r.connectionKey}" data-media="${e(r.media_id)}">${r.enabled ? 'Ⅱ Pausar' : '▷ Activar'}</button></div><details class="live-identifiers"><summary>ID de publicación</summary><p>${e(r.media_id)}</p></details></article>`).join('') : empty('Tu primera automatización.', 'Vincula un canal y configura el ID de una publicación para empezar.')}</div><p class="live-disclaimer">Al guardar cambios o reactivar una regla, solo se procesan comentarios nuevos. Los pendientes de la configuración anterior se cancelan. Los fallidos no se reenvían. Una solicitud que ya esté en curso puede terminar después de pausar.</p>`
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
            next[key] = {
              account,
              report,
              events,
              publications: channels[key]?.publications,
              publicationCheckedAt: channels[key]?.publicationCheckedAt,
            };
          } catch {
            next[key] = { ...channels[key], account, error: true };
          }
        }),
      );
      channels = next;
      const context = document.querySelector('.live-account-context strong');
      if (context && catalogue.business) {
        context.textContent = catalogue.business.name;
        const profileName = document.querySelector('.profile [data-profile-name]');
        if (profileName) profileName.textContent = catalogue.business.name;
      }
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
    void loadPublicationMetadata();
  }
  async function loadPublicationMetadata() {
    await Promise.all(
      configured().map(async ([key, data]) => {
        const maxAge = data.publications?.unavailable ? 60_000 : 300_000;
        if (metadataLoading.has(key) || Date.now() - (data.publicationCheckedAt || 0) < maxAge)
          return;
        metadataLoading.add(key);
        try {
          const result = await request(accountBase(key) + '/publications', {
            signal: AbortSignal.timeout(35_000),
          });
          if (channels[key]?.account.version !== data.account.version) return;
          channels[key].publications = result;
          channels[key].publicationCheckedAt = Date.now();
        } catch {
          if (channels[key]) {
            channels[key].publications = { ...channels[key].publications, unavailable: true };
            channels[key].publicationCheckedAt = Date.now();
          }
        } finally {
          metadataLoading.delete(key);
        }
      }),
    );
    if (
      !modal?.open &&
      !customerModal?.open &&
      !root.querySelector('input:focus,select:focus,textarea:focus')
    )
      render();
  }
  function publicationOptions(connectionKey) {
    return (
      '<option value="">Selecciona una publicación o pega su ID abajo</option>' +
      publications()
        .filter((p) => p.connectionKey === connectionKey && !p.rule)
        .map((p) => `<option value="${e(p.id)}">${e(p.title)}</option>`)
        .join('')
    );
  }
  function closeEditor() {
    if (saving) return;
    modal?.close();
    editor = null;
  }
  function openEditor(rule = null, draft = null) {
    if (loading) return;
    const accounts = configured();
    if (!accounts.length) {
      toast('Conecta primero una cuenta desde Canales.');
      return;
    }
    editor = rule || {
      connectionKey: draft?.connectionKey || accounts[0][0],
      channel: draft?.channel || networkFor(accounts[0][0]),
      media_id: draft?.id || '',
      public_text:
        (draft?.channel || networkFor(accounts[0][0])) === 'facebook'
          ? '{autor} Te mandé la información por Messenger.'
          : 'Te mandé la información por privado.',
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
          channels[connectionKey].publicationCheckedAt = 0;
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
    modal.innerHTML = `<form>
      <div class="live-editor-head">
      <div>
      <span class="live-eyebrow">COMENTARIO → MENSAJE PRIVADO</span>
      <h2 id="live-editor-title">${rule ? 'Editar automatización' : 'Nueva automatización'}</h2>
      </div>
      <button type="button" class="icon-button" data-editor-close aria-label="Cerrar">✕</button>
      </div>
      <label class="field">Canal<select name="channel" ${rule ? 'disabled' : ''}>${accounts.map(([channel, c]) => `<option value="${channel}" ${channel === editor.connectionKey ? 'selected' : ''}>${NETWORKS[networkFor(channel)]} · ${e(c.account.username)}</option>`).join('')}</select>
      </label>${
        !rule
          ? `<label class="field">Tus publicaciones<select name="publicationPick">${publicationOptions(editor.connectionKey)}</select>
      <small>Se muestran publicaciones recientes accesibles en Meta. Puedes usar el ID para publicaciones anteriores.</small>
      </label>`
          : ''
      }<label class="field">ID de la publicación<input name="mediaId" value="${e(editor.media_id)}" ${rule ? 'readonly' : ''} required maxlength="92" pattern="[0-9]+(_[0-9]+){0,2}" placeholder="Pega el ID de la publicación">
      <small>Usa el ID de Meta, no el enlace. ${rule ? 'Para otra publicación, crea una automatización nueva.' : 'Facebook: ID de página_ID de publicación. Instagram: ID del contenido.'}</small>
      </label>
      <label class="field">01 · Respuesta pública<textarea name="publicText" required maxlength="1000" placeholder="Te mandé la información por privado.">${e(editor.public_text)}</textarea>
      <small id="live-author-hint">En Facebook puedes usar {autor} para mencionar al autor del comentario.</small>
      </label>
      <label class="field">02 · Mensaje privado<textarea name="dmText" required maxlength="1000" placeholder="¡Hola! Aquí tienes la información…">${e(editor.dm_text)}</textarea>
      </label>
      <label class="field">Palabras clave, separadas por comas<input name="keywords" value="${e(JSON.parse(editor.keywords || '[]').join(', '))}" maxlength="1200" placeholder="precio, información, visita">
      <small>Déjalo vacío para responder a cualquier comentario elegible.</small>
      </label>
      <label class="field">Intervalo por persona y publicación (horas)<input name="cooldown" type="number" min="0" max="720" required value="${(editor.cooldown_seconds ?? 86400) / 3600}" step="1">
      <small>24 horas evita repetir el DM a la misma persona en el mismo post. 0 desactiva este control.</small>
      </label>
      <div class="live-editor-preview">
      <span>VISTA PREVIA</span>
      <p id="live-public-preview">
      </p>
      <span>DESPUÉS, POR PRIVADO</span>
      <p id="live-dm-preview">
      </p>
      </div>
      <p class="live-disclaimer">${editor.enabled ? 'Al guardar, responderá a comentarios nuevos en esta publicación.' : 'La automatización se mantendrá pausada.'} El DM se solicita después de confirmar la respuesta pública.</p>
      <p class="live-form-error" role="alert">
      </p>
      <div class="live-editor-actions">
      <button type="button" class="btn" data-editor-close>Cancelar</button>
      <button type="submit" class="btn primary">${rule ? 'Guardar cambios' : 'Guardar y activar'}</button>
      </div>
      </form>`;
    previewEditor();
    modal.showModal();
  }
  function previewEditor(event) {
    if (!modal || !editor) return;
    const form = modal.querySelector('form'),
      channel = networkFor(form.elements.channel.value);
    if (event?.target.name === 'channel') {
      form.elements.mediaId.value = '';
      if (
        [
          '{autor} Te mandé la información por Messenger.',
          'Te mandé la información por privado.',
        ].includes(form.elements.publicText.value)
      )
        form.elements.publicText.value =
          channel === 'facebook'
            ? '{autor} Te mandé la información por Messenger.'
            : 'Te mandé la información por privado.';
      const picker = form.elements.publicationPick;
      if (picker) picker.innerHTML = publicationOptions(form.elements.channel.value);
    }
    if (event?.target.name === 'publicationPick' && event.target.value)
      form.elements.mediaId.value = event.target.value;
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
      threadClosed = false;
      if (current !== 'activity') navigate('activity');
      else render();
      root.querySelector('.live-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (action === 'new-rule') openEditor();
    if (action === 'post-tab') {
      postTab = button.dataset.tab;
      selectedPost = null;
      selected = null;
      render();
    }
    if (action === 'close-thread') {
      threadClosed = true;
      selected = null;
      render();
    }
    if (action === 'publication' || action === 'post-detail') {
      selectedPost = button.dataset.post;
      selected = button.dataset.key || null;
      threadClosed = false;
      render();
      root
        .querySelector('.conversation-thread')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (action === 'activate-post') {
      const post = publications().find((p) => p.key === button.dataset.post);
      if (post) openEditor(null, post);
    }
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
  root.addEventListener('keydown', (event) => {
    const tab = event.target.closest('[data-live="post-tab"]');
    if (!tab || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = ['active', 'paused', 'available'];
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    postTab =
      event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs[2]
          : tabs[(tabs.indexOf(postTab) + offset + tabs.length) % tabs.length];
    selectedPost = null;
    selected = null;
    render();
    root.querySelector('#publication-tab-' + postTab)?.focus();
  });
  root.addEventListener('input', (event) => {
    if (event.target.id === 'post-search') {
      postQuery = event.target.value;
      const start = event.target.selectionStart;
      render();
      const input = root.querySelector('#post-search');
      input?.focus();
      input?.setSelectionRange(start, start);
      return;
    }
    if (event.target.id !== 'live-search') return;
    query = event.target.value;
    root.querySelector('#live-results').innerHTML = activityTable(filteredActivity());
    root.querySelector('.live-list-title span').textContent =
      `${filteredActivity().length} registros disponibles`;
  });
  root.addEventListener('change', (event) => {
    if (event.target.id === 'post-channel') {
      postChannel = event.target.value;
      selectedPost = null;
      render();
      return;
    }
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
  root.addEventListener(
    'error',
    (event) => {
      const image = event.target;
      if (image.matches?.('[data-publication-image]')) {
        image.closest('.post-photo')?.classList.remove('has-image');
        image.hidden = true;
      }
    },
    true,
  );
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
      threadClosed = false;
      const connection = configured().find(
        ([key, data]) =>
          networkFor(key) === item.channel && data.account.accountId === item.account_id,
      );
      selected = `${item.channel}:${item.account_id}:comment:${suffix(item.comment_id)}`;
      notificationActivity = {
        ...item,
        connectionKey: connection?.[0],
        accountName: connection?.[1].account.username,
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
