import {
  facebookGraph,
  readFacebook,
  writeFacebook,
  resolveFacebookPage,
  safeFacebookError,
} from './facebook-connection.mjs';

export const defaultFacebookAppId = '39748148371443102';
const validToken = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/\s/.test(value);
const timestamp = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
function appCredentials(appId, appSecret) {
  if (!/^\d{5,30}$/.test(appId || '') || !/^[a-fA-F0-9]{32}$/.test(appSecret || '')) {
    throw new Error('Facebook: revisa el ID y la clave secreta de la app Conversa.');
  }
}
async function requestJson(path, options, request) {
  let response, data;
  try {
    response = await request(`${facebookGraph}/${path}`, {
      ...options,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    data = await response.json();
  } catch {
    throw new Error(
      'Facebook: no se pudo comprobar la autorización. La credencial guardada se conserva.',
    );
  }
  if (!response.ok || data?.error) throw new Error(safeFacebookError(response.status, data));
  return data;
}

export async function exchangeFacebookUserToken({ userToken, appId, appSecret }, request = fetch) {
  appCredentials(appId, appSecret);
  if (!validToken(userToken))
    throw new Error('Facebook: introduce un token nuevo de USUARIO válido.');
  const data = await requestJson(
    'oauth/access_token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: userToken,
      }).toString(),
    },
    request,
  );
  // Do not accept a new token that would put the pilot back on an hourly lifetime.
  if (
    !validToken(data.access_token) ||
    !Number.isSafeInteger(data.expires_in) ||
    data.expires_in <= 86400
  ) {
    throw new Error(
      'Facebook: no confirmó un token de usuario de larga duración. Genera una autorización nueva; no se reemplazó la conexión.',
    );
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function inspectFacebookPageToken(config, request = fetch, now = Date.now) {
  appCredentials(config.appId, config.appSecret);
  if (!validToken(config.accessToken))
    throw new Error('Facebook: falta el token de página guardado.');
  // Meta's documented debug endpoint takes input_token in its HTTPS query.
  // This URL is server-only, never returned/logged; redirects and raw errors are blocked.
  const result = await requestJson(
    'debug_token?' + new URLSearchParams({ input_token: config.accessToken }),
    {
      headers: { Authorization: `Bearer ${config.appId}|${config.appSecret}` },
    },
    request,
  );
  const data = result?.data;
  if (!data || typeof data.is_valid !== 'boolean')
    throw new Error('Facebook: no devolvió un diagnóstico válido de la autorización.');
  if (data.is_valid) {
    if (String(data.app_id) !== config.appId || data.type !== 'PAGE')
      throw new Error('Facebook: el token no fue confirmado como token de PÁGINA de esta app.');
    if (data.profile_id !== undefined && String(data.profile_id) !== config.accountId)
      throw new Error('Facebook: el diagnóstico corresponde a otra página.');
    const identity = await requestJson(
      'me?fields=id',
      { headers: { Authorization: `Bearer ${config.accessToken}` } },
      request,
    );
    if (String(identity.id) !== config.accountId)
      throw new Error('Facebook: la autorización pertenece a otra página.');
  }
  return {
    valid: data.is_valid,
    checkedAt: new Date(now()).toISOString(),
    expiresAt: timestamp(data.expires_at),
    dataAccessExpiresAt: timestamp(data.data_access_expires_at),
  };
}

export async function connectFacebookDurable(
  { userToken, appId, appSecret, pageId },
  request = fetch,
  now = Date.now,
) {
  const extended = await exchangeFacebookUserToken({ userToken, appId, appSecret }, request);
  const page = await resolveFacebookPage(extended.accessToken, pageId, request);
  const tokenInfo = await inspectFacebookPageToken({ ...page, appId, appSecret }, request, now);
  const limits = [tokenInfo.expiresAt, tokenInfo.dataAccessExpiresAt].filter(
    (v) => v !== null && v > 0,
  );
  if (!tokenInfo.valid || limits.some((v) => v * 1000 <= now()))
    throw new Error(
      'Facebook: la autorización de página ya no está vigente. La conexión anterior se conserva.',
    );
  if (tokenInfo.expiresAt === null)
    throw new Error(
      'Facebook: no informó la caducidad del token de página. No se reemplazó la conexión.',
    );
  if (tokenInfo.expiresAt > 0 && tokenInfo.expiresAt * 1000 <= now() + 86400_000) {
    throw new Error(
      'Facebook: el token de página todavía vence en menos de un día. No se reemplazó la conexión.',
    );
  }
  // Neither the short nor the extended USER token leaves this function.
  return {
    ...page,
    appId,
    appSecret,
    tokenInfo,
    tokenSource: 'long-lived-user-exchange',
    checkedAt: tokenInfo.checkedAt,
  };
}

function unchanged(path, previous) {
  const current = readFacebook(path);
  if (
    !current ||
    ['accountId', 'ownerId', 'appSecret', 'accessToken', 'verifyToken'].some(
      (key) => current[key] !== previous[key],
    )
  ) {
    throw new Error('Facebook: la conexión cambió durante la operación. No se sobrescribió.');
  }
}
export async function renewFacebookConnection(
  path,
  userToken,
  appId,
  request = fetch,
  now = Date.now,
) {
  const previous = readFacebook(path);
  if (!previous?.accountId || !previous.ownerId)
    throw new Error('Facebook: configura primero la página.');
  const connected = await connectFacebookDurable(
    {
      userToken,
      appId: appId || previous.appId || defaultFacebookAppId,
      appSecret: previous.appSecret,
      pageId: previous.accountId,
    },
    request,
    now,
  );
  unchanged(path, previous);
  const config = { ...previous, ...connected };
  writeFacebook(path, config);
  return config;
}
export async function checkStoredFacebookToken(path, request = fetch, now = Date.now) {
  const previous = readFacebook(path);
  if (!previous?.accountId) throw new Error('Facebook: configura primero la página.');
  const appId = previous.appId || defaultFacebookAppId;
  const tokenInfo = await inspectFacebookPageToken({ ...previous, appId }, request, now);
  unchanged(path, previous);
  const config = { ...previous, appId, tokenInfo };
  writeFacebook(path, config);
  return config;
}

export function facebookCredentialStatus(config, actions = [], now = Date.now) {
  const info = config.tokenInfo;
  const checkedAt = info?.checkedAt || config.checkedAt || null;
  const checkedTime = Date.parse(checkedAt || '') || 0;
  const authFailure = actions.some(
    (action) =>
      action.account_id === config.accountId &&
      action.updated_at >= checkedTime &&
      /código 190\b/.test(action.last_error || ''),
  );
  const expiresAt = timestamp(info?.expiresAt),
    dataAccessExpiresAt = timestamp(info?.dataAccessExpiresAt);
  const deadlines = [expiresAt, dataAccessExpiresAt].filter((value) => value !== null && value > 0);
  const base = { checkedAt, expiresAt, dataAccessExpiresAt };
  if (authFailure || info?.valid === false || deadlines.some((value) => value * 1000 <= now())) {
    return {
      ...base,
      state: 'reconnect',
      message:
        'Facebook rechazó la autorización o llegó su vencimiento. Reconecta la cuenta para volver a responder.',
    };
  }
  if (deadlines.some((value) => value * 1000 <= now() + 7 * 86400_000)) {
    return {
      ...base,
      state: 'expiring',
      message:
        'La autorización o el acceso a datos vence en los próximos siete días. Prepara la reconexión.',
    };
  }
  if (!info || info.valid !== true || expiresAt === null)
    return {
      ...base,
      state: 'unknown',
      message: 'La vigencia todavía no fue comprobada con Meta.',
    };
  return {
    ...base,
    state: 'ok',
    message:
      expiresAt === 0
        ? 'Meta informó un token de página sin vencimiento programado. Puede invalidarlo; esta es la última comprobación guardada.'
        : 'Autorización comprobada. La fecha de vencimiento informada por Meta está guardada.',
  };
}
