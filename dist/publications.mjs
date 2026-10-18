export const escapePublication = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const e = escapePublication;
const networks = { facebook: 'Facebook', instagram: 'Instagram' };
export const needsAttention = (item) =>
  [
    'public_failed',
    'dm_failed',
    'public_unknown',
    'dm_unknown',
    'skipped_rate_limit',
    'skipped_late',
    'skipped_author',
  ].includes(item.status) || item.kind === 'message';
export const publicationKey = (connection, media) => `${connection}:${media}`;
export const networkMark = (channel) =>
  `<span class="post-network ${channel}" aria-hidden="true">${channel === 'facebook' ? 'f' : '◎'}</span>`;
export const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => [...s][0])
    .join('')
    .toUpperCase();
export function safePublicationUrl(value, image = false) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.searchParams.has('access_token')
    )
      return null;
    if (
      image
        ? !['fbcdn.net', 'cdninstagram.com'].some((domain) => host.endsWith('.' + domain))
        : ![
            'facebook.com',
            'www.facebook.com',
            'm.facebook.com',
            'instagram.com',
            'www.instagram.com',
          ].includes(host)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function inboxUrl(channel, accountId) {
  if (channel === 'facebook' && /^\d{5,30}$/.test(accountId || ''))
    return `https://business.facebook.com/latest/inbox/all?asset_id=${accountId}`;
  if (channel === 'instagram') return 'https://www.instagram.com/direct/inbox/';
  return null;
}
export function buildPublications(channels, activities = []) {
  const posts = [];
  for (const [connectionKey, data] of Object.entries(channels)) {
    if (!data.account?.configured) continue;
    const channel = data.account.channel || connectionKey;
    const own = activities.filter((a) => a.connectionKey === connectionKey && a.kind === 'comment');
    const metadata = new Map((data.publications?.posts || []).map((p) => [p.id, p]));
    const rules = new Map((data.report?.rules || []).map((r) => [r.media_id, r]));
    const ids = new Set([
      ...rules.keys(),
      ...metadata.keys(),
      ...own.map((a) => a.media_id).filter(Boolean),
    ]);
    for (const id of ids) {
      const rule = rules.get(id),
        source = metadata.get(id);
      const items = own
        .filter((a) => a.media_id === id)
        .sort((a, b) => b.created_at - a.created_at);
      posts.push({
        key: publicationKey(connectionKey, id),
        connectionKey,
        channel,
        accountId: data.account.accountId,
        accountName: data.account.username,
        id,
        title: source?.title || `Publicación de ${networks[channel]}`,
        caption: source?.caption || '',
        image: safePublicationUrl(source?.image, true),
        permalink: safePublicationUrl(source?.permalink),
        publishedAt: source?.publishedAt || null,
        hasMetadata: Boolean(source),
        unavailable: data.publications?.unavailable || data.error || false,
        rule: rule ? { ...rule, channel, connectionKey } : null,
        state: rule ? (rule.enabled ? 'active' : 'paused') : 'available',
        items,
        attention: items.filter(needsAttention).length,
        latest: Math.max(
          rule?.enabled_at || 0,
          items[0]?.created_at || 0,
          Date.parse(source?.publishedAt) || 0,
        ),
      });
    }
  }
  return posts.sort((a, b) => b.latest - a.latest);
}
export const postDate = (value) =>
  value
    ? new Date(value).toLocaleString('es-BO', {
        timeZone: 'America/La_Paz',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
export function postPhoto(post, small = false) {
  const image = safePublicationUrl(post.image, true);
  return `<div class="post-photo ${small ? 'small' : ''} ${image ? 'has-image' : ''}">${image ? `<img data-publication-image src="${e(image)}" alt="${e(post.title)}" loading="lazy" referrerpolicy="no-referrer">` : ''}<div class="post-photo-fallback" aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="10" y="12" width="44" height="40" rx="5"/>
      <circle cx="24" cy="25" r="4"/>
      <path d="m12 45 13-12 8 7 8-9 12 14"/>
      </svg>
      <span>${post.hasMetadata ? 'Vista no disponible' : 'Vista de la publicación'}</span>
      </div>${networkMark(post.channel)}</div>`;
}
export function postState(post) {
  if (post.attention) return '<span class="post-status attention">Requiere atención</span>';
  if (post.state === 'paused')
    return '<span class="post-status paused">Automatización pausada</span>';
  if (post.state === 'available')
    return '<span class="post-status paused">Sin automatización</span>';
  return '<span class="post-status active"><i></i>Automatización activa</span>';
}
export function publicationCard(post, selectedKey) {
  return `<article class="publication-card ${selectedKey === post.key ? 'selected' : ''}">
    <button class="post-image-button" data-live="publication" data-post="${e(post.key)}" aria-label="Abrir ${e(post.title)}">${postPhoto(post)}</button>
    <div class="post-card-body">
      <div class="post-card-heading">
      <h2>
      <button data-live="publication" data-post="${e(post.key)}">${e(post.title)}</button>
      </h2>${postState(post)}</div>
      <p class="post-account">${networkMark(post.channel)}${networks[post.channel]}<span>· ${e(post.accountName)}</span>
      </p>
      <div class="post-people">${
        post.items.length
          ? post.items
              .slice(0, 2)
              .map(
                (a) =>
                  `<button class="post-person" data-live="post-detail" data-post="${e(post.key)}" data-key="${e(a.key)}">
      <span class="person-initials">${e(initials(a.author))}</span>
      <span>
      <strong>${e(a.author)}</strong>
      <small>${e(a.text || 'Ver resultado del comentario')}</small>
      </span>
      <span class="post-person-arrow" aria-hidden="true">↗</span>${needsAttention(a) ? '<i class="person-attention" aria-label="Requiere atención"></i>' : ''}</button>`,
              )
              .join('')
          : `<p class="post-no-comments">${post.state === 'active' ? 'Lista para recibir nuevos comentarios.' : post.state === 'paused' ? 'Tus mensajes están guardados. Actívala cuando quieras.' : 'Elige qué responder cuando alguien comente.'}</p>`
      }</div>
      <div class="post-card-actions">
      <button class="post-text-link" data-live="publication" data-post="${e(post.key)}">${post.items.length ? 'Ver conversaciones' : post.rule ? 'Ver publicación' : 'Preparar automatización'} <span aria-hidden="true">→</span>
      </button>${post.rule ? `<button class="post-edit" data-live="edit-rule" data-connection="${e(post.connectionKey)}" data-media="${e(post.id)}" aria-label="Editar mensajes de ${e(post.title)}">Editar mensajes</button>` : ''}</div>
    </div>
  </article>`;
}
const statusText = {
  received: 'Comentario recibido',
  pending: 'En cola',
  public_sending: 'Respondiendo comentario',
  public_done: 'Mensaje privado pendiente',
  dm_sending: 'Enviando mensaje privado',
  sent: 'Ambos envíos aceptados por Meta',
  public_failed: 'Respuesta pública rechazada',
  dm_failed: 'Mensaje privado rechazado',
  public_unknown: 'Respuesta pública sin confirmar',
  dm_unknown: 'Mensaje privado sin confirmar',
  skipped_rate_limit: 'Límite horario alcanzado',
  skipped_late: 'Comentario recibido fuera de plazo',
  skipped_author: 'Autor sin identificar',
  skipped_person: 'Persona ya atendida en esta publicación',
  skipped_keyword: 'No coincide con las palabras clave',
  cancelled: 'Envío cancelado',
  expired: 'Envío vencido',
  incoming: 'Mensaje entrante',
};
export function conversationDetail(item, post, account = {}) {
  const channel = item?.channel || post?.channel || account.channel;
  const accountId = post?.accountId || account.accountId;
  const accountName = post?.accountName || item?.accountName || account.username || 'Tu negocio';
  const inbox = inboxUrl(channel, accountId);
  const picture = post
    ? `<div class="thread-publication">${postPhoto(post, true)}<div>
      <strong>${e(post.title)}</strong>
      <small>${networkMark(channel)}${networks[channel]} · ${e(accountName)}</small>
      </div>${post.permalink ? `<a class="thread-external" href="${e(post.permalink)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir publicación en ${networks[channel]}">↗</a>` : ''}</div>`
    : '';
  if (!item)
    return `<div class="thread-head">
      <div>
      <span class="post-kicker">PUBLICACIÓN</span>
      <h2>${e(post?.title || 'Tus conversaciones')}</h2>
      </div>
      </div>${picture}<div class="thread-empty">
      <span aria-hidden="true">↗</span>
      <h3>${post ? 'El primer comentario abre la conversación.' : 'Todo empieza con una publicación.'}</h3>
      <p>${post?.rule ? 'Aquí verás el comentario y el resultado de las respuestas de Conversa.' : 'Activa una publicación y prepara la respuesta pública y el mensaje privado.'}</p>
      </div>${
        post
          ? `<div class="thread-bottom">${
              post.rule
                ? `<div class="thread-rule-preview">
      <small>RESPUESTA PÚBLICA</small>
      <p>${e(post.rule.public_text)}</p>
      <small>MENSAJE PRIVADO</small>
      <p>${e(post.rule.dm_text)}</p>
      </div>`
                : ''
            }<button class="btn primary" data-live="${post.rule ? 'edit-rule' : 'activate-post'}" data-connection="${e(post.connectionKey)}" data-media="${e(post.id)}" data-post="${e(post.key)}">${post.rule ? 'Editar mensajes' : 'Activar esta publicación'}</button>
      </div>`
          : ''
      }`;
  const publicText = String(item.public_text || '').replace(
    /@\[\d+\]|\{autor\}/g,
    item.author || 'Autor del comentario',
  );
  const bubble = (label, message, business, result = '') =>
    `<section class="thread-message ${business ? 'business' : ''}">
      <span class="person-initials ${business ? 'business-avatar' : ''}" aria-hidden="true">${e(initials(business ? accountName : item.author))}</span>
      <div>
      <span class="thread-label ${business ? 'business-label' : ''}">${label}</span>
      <strong>${e(business ? accountName : item.author)}</strong>
      <p class="thread-bubble">${e(message)}</p>${result ? `<small class="thread-result">${e(result)}</small>` : ''}</div>
      </section>`;
  return `<div class="thread-head">
      <span class="person-initials large">${e(initials(item.author))}</span>
      <div>
      <h2>${e(item.author)}</h2>
      <p>${post ? e(post.title) : networks[channel] || 'Conversación'}</p>
      </div>
      <button class="icon-button" data-live="close-thread" aria-label="Cerrar detalle">✕</button>
      </div>${picture}
    <div class="thread-messages">${bubble(item.kind === 'message' ? 'Mensaje entrante' : 'Comentario', item.text || 'El texto original ya no está entre las entradas conservadas.', false, postDate(item.created_at))}
      ${item.kind === 'comment' && item.public_text ? bubble('Respuesta pública', publicText, true, item.public_id ? '✓ Aceptada por Meta' : item.status === 'public_failed' ? 'Rechazada por Meta' : 'Sin confirmar') : ''}
      ${item.kind === 'comment' && item.dm_text ? bubble(channel === 'facebook' ? 'Messenger' : 'Mensaje privado', item.dm_text, true, item.message_id ? '✓ Aceptado por Meta' : item.status === 'dm_failed' ? 'Rechazado por Meta' : 'Sin confirmar') : ''}
    </div>
      <div class="thread-bottom">
      <div class="thread-outcome ${needsAttention(item) ? 'attention' : item.status === 'sent' ? 'success' : ''}" role="status">${e(statusText[item.status] || 'Resultado por revisar')}</div>${item.last_error ? `<p class="thread-error">${e(item.last_error)}</p>` : ''}${
        inbox
          ? `<a class="btn primary thread-inbox" href="${e(inbox)}" target="_blank" rel="noopener noreferrer">${networkMark(channel)}${channel === 'facebook' ? 'Abrir bandeja de Meta' : 'Abrir mensajes de Instagram'} <span aria-hidden="true">↗</span>
      </a>`
          : ''
      }<p class="thread-note">${item.kind === 'message' ? 'Continúa la conversación desde la cuenta correspondiente en Meta.' : 'La aceptación de Meta no confirma lectura ni notificación.'}</p>${
        item.comment_id
          ? `<details class="live-identifiers">
      <summary>Datos de esta actividad</summary>
      <p>Comentario: ${e(item.comment_id)}</p>
      <p>Publicación: ${e(item.media_id)}</p>
      </details>`
          : ''
      }</div>`;
}
