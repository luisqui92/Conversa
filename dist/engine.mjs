// Motor de un prototipo local. Los resultados de entrega son simulados.
export const CHANNELS = ['Instagram', 'Facebook', 'TikTok'];
export const PLANS = {
  piloto: { name: 'Piloto', price: 99, limit: 500, accounts: 3, users: 2 },
  negocio: { name: 'Negocio', price: 149, limit: 1000, accounts: 3, users: 2 },
  agencia: { name: 'Agencia', price: 299, limit: 3000, accounts: 9, users: 5 },
};
export const normalize = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
export const hasKeywords = (text, keywords) =>
  keywords.some((k) => normalize(k) && ` ${normalize(text)} `.includes(` ${normalize(k)} `));
export const makeId = () =>
  globalThis.crypto?.randomUUID?.() || `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const LEAD_STAGES = {
  new: 'Nuevo',
  contacted: 'Contactado',
  qualified: 'Calificado',
  visit_requested: 'Visita solicitada',
  visit_confirmed: 'Visita confirmada',
  won: 'Cierre registrado',
  lost: 'Descartado',
};
const fields = [
  'nombre',
  'negocio',
  'producto',
  'precio',
  'moneda',
  'detalle',
  'horario',
  'reserva',
  'operacion',
  'zona',
  'superficie',
  'dormitorios',
  'banos',
  'tipo',
];
export const priceLabel = (c) =>
  `${c.currency === 'USD' ? 'USD ' : c.currency || 'Bs'}${c.vertical === 'realestate' ? Number(c.price || 0).toLocaleString('es-BO') : c.price}`;
export function renderTemplate(template, campaign, name, business) {
  const values = {
    nombre: name,
    negocio: business,
    producto: campaign.product,
    precio:
      campaign.vertical === 'realestate'
        ? Number(campaign.price || 0).toLocaleString('es-BO')
        : campaign.price,
    moneda: campaign.currency === 'USD' ? 'USD ' : campaign.currency || 'Bs',
    detalle: campaign.description,
    horario: campaign.hours,
    reserva:
      campaign.bookingUrl ||
      (campaign.vertical === 'realestate'
        ? 'Responde a este mensaje para solicitar una visita.'
        : 'Responde a este mensaje para consultar una reserva.'),
    operacion: campaign.operation || '',
    zona: campaign.location || '',
    superficie: campaign.area || '',
    dormitorios: campaign.bedrooms ?? '',
    banos: campaign.bathrooms ?? '',
    tipo: campaign.propertyType || '',
  };
  return String(template || '').replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!fields.includes(key)) throw new Error(`Variable no reconocida: {${key}}`);
    return String(values[key] ?? '');
  });
}
export function validateCampaign(campaign, campaigns = []) {
  const errors = [];
  for (const field of ['title', 'postId', 'product', 'description', 'hours'])
    if (!String(campaign[field] || '').trim())
      errors.push(
        `Completa ${{ title: 'el nombre de la campaña', postId: 'el identificador del post', product: 'la oferta', description: 'los detalles', hours: 'el horario' }[field]}.`,
      );
  if (!CHANNELS.includes(campaign.channel)) errors.push('Selecciona un canal compatible.');
  if (campaign.currency && !['Bs', 'USD'].includes(campaign.currency))
    errors.push('Selecciona Bs o USD como moneda.');
  if (campaign.vertical === 'realestate') {
    if (!['Venta', 'Alquiler', 'Anticrético'].includes(campaign.operation))
      errors.push('Selecciona venta, alquiler o anticrético.');
    if (!String(campaign.location || '').trim()) errors.push('Completa la zona del inmueble.');
    if (!Number.isFinite(Number(campaign.area)) || Number(campaign.area) <= 0)
      errors.push('La superficie debe ser mayor a cero.');
    for (const key of ['bedrooms', 'bathrooms'])
      if (
        String(campaign[key] ?? '').trim() === '' ||
        !Number.isInteger(Number(campaign[key])) ||
        Number(campaign[key]) < 0
      )
        errors.push('Los dormitorios y baños deben ser números enteros mayores o iguales a cero.');
  }
  if (!['both', 'public'].includes(campaign.action))
    errors.push('Selecciona un tipo de respuesta compatible.');
  if (
    String(campaign.price).trim() === '' ||
    !Number.isFinite(Number(campaign.price)) ||
    Number(campaign.price) < 0
  )
    errors.push('El precio debe ser un número válido mayor o igual a cero.');
  if (
    !campaign.anyComment &&
    !(Array.isArray(campaign.keywords) && campaign.keywords.some((k) => normalize(k)))
  )
    errors.push('Añade al menos una palabra o frase.');
  if (campaign.action === 'both' && !String(campaign.privateTemplate || '').trim())
    errors.push('Escribe el mensaje privado.');
  if (!String(campaign.publicTemplate || '').trim()) errors.push('Escribe la respuesta pública.');
  if (campaign.action === 'both' && !String(campaign.fallbackTemplate || '').trim())
    errors.push('Escribe la respuesta cuando no se pueda enviar el DM.');
  if (campaign.bookingUrl) {
    try {
      const u = new URL(campaign.bookingUrl);
      if (u.protocol !== 'https:') throw new Error();
    } catch {
      errors.push('El enlace de reserva debe ser una URL HTTPS válida.');
    }
  }
  if (campaign.expiresAt && Number.isNaN(new Date(campaign.expiresAt).getTime()))
    errors.push('La fecha de vigencia no es válida.');
  if (
    campaigns.some(
      (c) => c.id !== campaign.id && c.postId === campaign.postId && c.channel === campaign.channel,
    )
  )
    errors.push('Este post ya tiene una campaña en este espacio. Edita la existente.');
  for (const template of [
    campaign.privateTemplate,
    campaign.publicTemplate,
    campaign.fallbackTemplate,
  ]) {
    try {
      renderTemplate(template, campaign, 'Cliente', 'Empresa');
    } catch (error) {
      errors.push(error.message);
    }
  }
  return [...new Set(errors)];
}
export function usage(workspace, now = new Date()) {
  const month = new Date(now).toISOString().slice(0, 7);
  return workspace.events
    .flatMap((e) => e.messages || [])
    .filter(
      (m) => m.sender === 'business' && m.origin === 'automation' && m.at.slice(0, 7) === month,
    ).length;
}
function quotaAllows(workspace, amount, now) {
  return usage(workspace, now) + amount <= (PLANS[workspace.plan]?.limit ?? 1000);
}
const message = (type, sender, text, now, origin = 'automation') => ({
  id: makeId(),
  type,
  sender,
  text,
  at: new Date(now).toISOString(),
  origin,
  demo: true,
});
const eligibility = (channel, options) =>
  channel !== 'TikTok' || options?.tiktokCommentToMessage === true;
function incomingBase(input, workspace, now) {
  if (input.workspaceId !== workspace.id)
    throw new Error('El comentario pertenece a otro espacio de trabajo.');
  return {
    ...input,
    id: input.id || makeId(),
    at: input.at || new Date(now).toISOString(),
    source: input.source || 'comment',
    status: 'pending',
    conversation: 'pending',
    reason: '',
    messages: [],
    timeline: [],
    snapshot: null,
    demo: true,
  };
}
export function processCampaignComment(workspace, input, options = {}) {
  const now = options.now || new Date();
  if (input.workspaceId !== workspace.id)
    throw new Error('El comentario pertenece a otro espacio de trabajo.');
  const duplicate = workspace.events.find(
    (e) =>
      e.source === 'comment' &&
      e.channel === input.channel &&
      e.postId === input.postId &&
      e.externalId === input.externalId,
  );
  if (duplicate && input.externalId) return { duplicate: true, event: duplicate };
  const event = incomingBase(input, workspace, now);
  const pending = (reason) => {
    event.reason = reason;
    event.timeline.push({ text: reason, at: new Date(now).toISOString() });
    return { duplicate: false, event };
  };
  if (input.isOwner) {
    event.status = 'ignored';
    return pending('Comentario del propio negocio: se omite la automatización.');
  }
  const campaign = workspace.campaigns.find(
    (c) => c.postId === input.postId && c.channel === input.channel,
  );
  if (!campaign) return pending('Esta publicación no tiene una campaña configurada.');
  event.campaignId = campaign.id;
  event.postTitle = campaign.title;
  event.snapshot = { ...campaign, keywords: [...campaign.keywords] };
  if (!campaign.active) return pending('La campaña está pausada.');
  if (
    campaign.vertical === 'realestate' &&
    campaign.availability &&
    campaign.availability !== 'available'
  )
    return pending('El inmueble no está disponible. Un asesor debe revisar la consulta.');
  if (campaign.expiresAt && new Date(campaign.expiresAt) < new Date(now))
    return pending('La promoción venció. Revisa el contenido antes de responder.');
  if (!campaign.anyComment && !hasKeywords(input.text, campaign.keywords))
    return pending('El comentario no coincide con las palabras configuradas.');
  const errors = validateCampaign(campaign);
  if (errors.length) return pending(`Revisa la campaña: ${errors[0]}`);
  const originalDate = new Date(input.at || now);
  if (Number.isNaN(originalDate.getTime()) || originalDate > new Date(now))
    return pending('La fecha del comentario no es válida.');
  const privateEligible =
    eligibility(input.channel, options) &&
    !options.privateReplyUsed &&
    new Date(now) - originalDate <= 7 * 24 * 60 * 60 * 1000;
  const names = [input.name || 'Cliente', workspace.label];
  const response = (template) => renderTemplate(template, campaign, ...names);
  if (campaign.action === 'public') {
    if (!quotaAllows(workspace, 1, now))
      return pending('Se alcanzó el límite de acciones automáticas del plan.');
    event.messages.push(message('public', 'business', response(campaign.publicTemplate), now));
    event.status = 'automatic';
    event.conversation = 'public_only';
    event.reason = 'Respuesta pública simulada.';
  } else if (!privateEligible || options.delivery === 'rejected') {
    const reason = !eligibility(input.channel, options)
      ? 'DM por comentario pendiente de habilitación en TikTok.'
      : options.privateReplyUsed
        ? 'Este comentario ya recibió una respuesta privada.'
        : new Date(now) - originalDate > 7 * 24 * 60 * 60 * 1000
          ? 'El comentario supera la ventana de prueba para una respuesta privada.'
          : 'El canal rechazó el envío del DM en esta simulación.';
    event.conversation = 'blocked';
    event.reason = reason;
    event.timeline.push({ text: reason, at: new Date(now).toISOString() });
    if (quotaAllows(workspace, 1, now))
      event.messages.push(message('public', 'business', response(campaign.fallbackTemplate), now));
  } else {
    if (!quotaAllows(workspace, 2, now))
      return pending('No quedan suficientes acciones para enviar el DM y su confirmación pública.');
    event.messages.push(message('dm', 'business', response(campaign.privateTemplate), now));
    event.timeline.push({
      text: 'Entrega privada confirmada en la simulación.',
      at: new Date(now).toISOString(),
    });
    event.messages.push(message('public', 'business', response(campaign.publicTemplate), now));
    event.status = 'automatic';
    event.conversation = 'awaiting_contact';
    event.reason = 'Esperando respuesta de la persona al mensaje privado.';
    event.leadStage = 'contacted';
  }
  event.timeline.push({ text: event.reason, at: new Date(now).toISOString() });
  return { duplicate: false, event };
}
export function suggestDM(text, campaign) {
  if (!campaign) return '';
  if (campaign.vertical === 'realestate') {
    if (hasKeywords(text, ['visita', 'visitar', 'conocer', 'agendar', 'cita']))
      return campaign.bookingUrl
        ? `Puedes solicitar una visita aquí: ${campaign.bookingUrl}. Un asesor confirmará el horario y la disponibilidad.`
        : `¿Qué día y horario te viene bien para visitar ${campaign.product}? Un asesor confirmará el horario y la disponibilidad.`;
    if (hasKeywords(text, ['zona', 'ubicacion', 'donde', 'direccion']))
      return `${campaign.product} está en ${campaign.location}. Un asesor te ayudará con los detalles de la visita.`;
    if (
      hasKeywords(text, [
        'dormitorios',
        'dormitorio',
        'habitaciones',
        'cuartos',
        'superficie',
        'metros',
        'm2',
        'banos',
        'bano',
      ])
    )
      return `${campaign.product}: ${campaign.area} m², ${campaign.bedrooms} dormitorios y ${campaign.bathrooms} baños. ${campaign.description}`;
    if (hasKeywords(text, ['precio', 'cuanto cuesta', 'cuanto', 'costo', 'vale']))
      return `${campaign.operation} de ${campaign.product}: ${priceLabel(campaign)}${campaign.operation === 'Alquiler' ? ' por mes' : ''}. Zona: ${campaign.location}. ${campaign.description}`;
    if (hasKeywords(text, ['info', 'informacion', 'detalles']))
      return `${campaign.operation}: ${campaign.product} en ${campaign.location}. ${priceLabel(campaign)}${campaign.operation === 'Alquiler' ? ' por mes' : ''}. ${campaign.area} m², ${campaign.bedrooms} dormitorios y ${campaign.bathrooms} baños. ${campaign.description}`;
    if (hasKeywords(text, ['horario', 'hora', 'cuando', 'abren']))
      return `El horario de atención para esta publicación es: ${campaign.hours}. Un asesor confirmará las visitas.`;
    return '';
  }
  if (hasKeywords(text, ['reservar', 'reserva', 'mesa']))
    return campaign.bookingUrl
      ? `Puedes solicitar una reserva aquí: ${campaign.bookingUrl}. El restaurante confirmará la disponibilidad.`
      : `¡Claro! Indícanos fecha, hora y cantidad de personas. Nuestro equipo confirmará la disponibilidad para ${campaign.product}.`;
  if (hasKeywords(text, ['precio', 'cuanto cuesta', 'cuanto', 'costo']))
    return `${campaign.product} cuesta ${campaign.currency || 'Bs'}${campaign.price}. ${campaign.description}`;
  if (hasKeywords(text, ['horario', 'hora', 'cuando', 'abren']))
    return `El horario de esta publicación es: ${campaign.hours}.`;
  if (hasKeywords(text, ['menu', 'incluye', 'informacion', 'info']))
    return `${campaign.product}: ${campaign.description}. Precio: ${campaign.currency || 'Bs'}${campaign.price}. Horario: ${campaign.hours}.`;
  return '';
}
export function continuationAllowed(event, now = new Date()) {
  const latest = event.messages.filter((m) => m.type === 'dm' && m.sender === 'contact').at(-1);
  return Boolean(
    latest &&
      new Date(now) >= new Date(latest.at) &&
      new Date(now) - new Date(latest.at) <= 24 * 60 * 60 * 1000,
  );
}
export function receivePrivateMessage(workspace, event, text, options = {}) {
  if (event.workspaceId !== workspace.id)
    throw new Error('La conversación pertenece a otro espacio de trabajo.');
  const now = options.now || new Date();
  if (!String(text).trim()) throw new Error('Escribe el mensaje del cliente.');
  const next = { ...event, messages: [...event.messages], timeline: [...event.timeline] };
  next.messages.push(message('dm', 'contact', String(text).trim(), now, 'customer'));
  next.conversation = 'awaiting_team';
  next.status = 'pending';
  next.reason = 'Nuevo mensaje privado: pendiente de respuesta.';
  const suggestion = suggestDM(text, next.snapshot);
  const currentCampaign = workspace.campaigns.find(
    (c) => c.id === next.campaignId && c.postId === next.postId && c.channel === next.channel,
  );
  const validOffer =
    currentCampaign?.active &&
    (currentCampaign.vertical !== 'realestate' ||
      !currentCampaign.availability ||
      currentCampaign.availability === 'available') &&
    (!currentCampaign.expiresAt || new Date(currentCampaign.expiresAt) >= new Date(now)) &&
    (!next.snapshot?.expiresAt || new Date(next.snapshot.expiresAt) >= new Date(now));
  const sameOffer =
    currentCampaign &&
    next.snapshot &&
    [
      'product',
      'price',
      'currency',
      'description',
      'hours',
      'bookingUrl',
      'operation',
      'location',
      'area',
      'bedrooms',
      'bathrooms',
      'propertyType',
    ].every((key) => String(currentCampaign[key] ?? '') === String(next.snapshot[key] ?? ''));
  if (
    next.snapshot?.autoFollowup &&
    currentCampaign?.autoFollowup &&
    validOffer &&
    sameOffer &&
    suggestion &&
    quotaAllows(workspace, 1, now)
  ) {
    next.messages.push(message('dm', 'business', suggestion, now));
    next.conversation = 'awaiting_contact';
    next.status = 'automatic';
    next.reason = 'Pregunta habitual respondida con la información de esta publicación.';
  }
  if (next.snapshot && !validOffer)
    next.reason =
      'La campaña está pausada, eliminada o vencida. Tu equipo debe revisar el mensaje.';
  else if (next.snapshot && !sameOffer)
    next.reason =
      'La oferta se actualizó desde el primer DM. Tu equipo debe revisar la información antes de responder.';
  next.timeline.push({ text: next.reason, at: new Date(now).toISOString() });
  if (
    next.snapshot?.vertical === 'realestate' &&
    hasKeywords(text, ['visita', 'visitar', 'agendar', 'conocer', 'cita']) &&
    !['qualified', 'visit_requested', 'visit_confirmed', 'won', 'lost'].includes(next.leadStage)
  )
    next.leadStage = 'visit_requested';
  return next;
}
export function receiveDirectMessage(workspace, input, options = {}) {
  const now = options.now || new Date();
  const event = incomingBase({ ...input, source: 'dm' }, workspace, now);
  const campaign = workspace.campaigns.find(
    (c) =>
      c.id === input.campaignId &&
      c.channel === input.channel &&
      c.active &&
      (!c.expiresAt || new Date(c.expiresAt) >= new Date(now)),
  );
  if (campaign) {
    event.campaignId = campaign.id;
    event.postTitle = campaign.title;
    event.postId = campaign.postId;
    event.snapshot = { ...campaign, keywords: [...campaign.keywords] };
  }
  return receivePrivateMessage(workspace, event, input.text, options);
}
export function manualReply(workspace, event, text, type = 'dm', options = {}) {
  if (event.workspaceId !== workspace.id)
    throw new Error('La conversación pertenece a otro espacio de trabajo.');
  const now = options.now || new Date();
  if (!['public', 'dm'].includes(type)) throw new Error('Selecciona un tipo de respuesta válido.');
  if (!String(text).trim()) throw new Error('Escribe una respuesta.');
  if (type === 'public' && event.source !== 'comment')
    throw new Error('Este hilo no tiene un comentario público.');
  if (type === 'dm' && !continuationAllowed(event, now))
    throw new Error(
      'Para continuar por DM, la persona debe responder primero. Si su último mensaje supera 24 horas, espera uno nuevo.',
    );
  const next = { ...event, messages: [...event.messages], timeline: [...event.timeline] };
  next.messages.push(message(type, 'business', String(text).trim(), now, 'manual'));
  next.status = 'manual';
  next.conversation = type === 'dm' ? 'awaiting_contact' : event.conversation;
  next.reason = 'Respuesta manual guardada en la simulación.';
  return next;
}
export function updateLeadStage(workspace, event, stage, options = {}) {
  if (event.workspaceId !== workspace.id)
    throw new Error('El prospecto pertenece a otro espacio de trabajo.');
  if (!Object.hasOwn(LEAD_STAGES, stage)) throw new Error('Selecciona una etapa válida.');
  if ((event.leadStage || 'new') === stage)
    return {
      ...event,
      leadStage: stage,
      timeline: [...event.timeline],
      conversions: [...(event.conversions || [])],
    };
  const now = options.now || new Date();
  if ((stage === 'visit_confirmed' || stage === 'won') && !options.confirmed)
    throw new Error('Confirma el resultado antes de registrarlo.');
  const next = {
    ...event,
    leadStage: stage,
    timeline: [
      ...event.timeline,
      {
        text: `Etapa registrada por el equipo: ${LEAD_STAGES[stage]}.`,
        at: new Date(now).toISOString(),
      },
    ],
  };
  // Registro local; no se envían eventos al Pixel ni a Conversions API.
  next.conversions = [
    ...(event.conversions || []),
    { id: makeId(), stage, at: new Date(now).toISOString(), source: 'manual', demo: true },
  ];
  return next;
}
