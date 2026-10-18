import { graphOrigin, inspectInstagramToken } from './instagram-connection.mjs';
import { inspectFacebookPageToken } from './facebook-token.mjs';

async function metaJSON(url, options, request) {
  let response, data;
  try {
    response = await request(url, {
      ...options,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    data = await response.json();
  } catch {
    throw new Error('No se pudo contactar a Meta. Se conserva la autorización anterior.');
  }
  if (!response.ok || data?.error)
    throw Object.assign(
      new Error('Meta no pudo renovar la autorización. Revisa la conexión desde Canales.'),
      { invalid: data?.error?.code === 190 },
    );
  return data;
}
export async function refreshInstagramCredential(config, request = fetch, now = Date.now) {
  // The documented token refresh endpoint uses a server-only query. Never log its URL or provider body.
  const query = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: config.accessToken,
  });
  const result = await metaJSON(
    'https://graph.instagram.com/refresh_access_token?' + query,
    {},
    request,
  );
  if (
    typeof result.access_token !== 'string' ||
    !result.access_token ||
    result.access_token.length > 8192 ||
    /\s/.test(result.access_token) ||
    !Number.isSafeInteger(result.expires_in) ||
    result.expires_in <= 86400
  )
    throw new Error(
      'Meta no confirmó una autorización de larga duración. Se conserva la anterior.',
    );
  const profile = await inspectInstagramToken(result.access_token, request);
  if (profile.accountId !== config.accountId)
    throw new Error('La renovación devolvió otra cuenta. Se conserva la anterior.');
  return {
    ...config,
    accessToken: result.access_token,
    username: profile.username,
    checkedAt: new Date(now()).toISOString(),
    tokenInfo: {
      valid: true,
      checkedAt: new Date(now()).toISOString(),
      expiresAt: Math.floor(now() / 1000) + result.expires_in,
      dataAccessExpiresAt: null,
    },
    nextRefreshAt: now() + Math.max(86400, result.expires_in - 15 * 86400) * 1000,
  };
}
export function createCredentialMaintenance({
  registry,
  request = fetch,
  now = Date.now,
  onError = () => {},
}) {
  let timer,
    stopped = false,
    running = null;
  async function process(config) {
    if (!registry.maintenanceClaim(config.id)) return;
    try {
      const updated =
        config.channel === 'instagram'
          ? await refreshInstagramCredential(config, request, now)
          : { ...config, tokenInfo: await inspectFacebookPageToken(config, request, now) };
      updated.checkedAt = updated.tokenInfo.checkedAt;
      registry.put(config.channel, updated, { expectedVersion: config.version });
      registry.maintenanceDone(config.id, {
        nextAttempt: config.channel === 'instagram' ? updated.nextRefreshAt : now() + 86400_000,
      });
    } catch (error) {
      const current = registry.get(config.id);
      if (current && current.version !== config.version) {
        registry.maintenanceDone(config.id, {
          nextAttempt: current.nextRefreshAt || now() + 86400_000,
        });
        return;
      }
      if (error.invalid)
        try {
          registry.put(
            config.channel,
            {
              ...config,
              tokenInfo: {
                ...config.tokenInfo,
                valid: false,
                checkedAt: new Date(now()).toISOString(),
              },
            },
            { expectedVersion: config.version },
          );
        } catch {
          /* Reconnection wins. */
        }
      registry.maintenanceDone(config.id, {
        nextAttempt: now() + 3600_000,
        error: 'No se pudo comprobar o renovar la autorización. Revisa Canales.',
      });
      onError('No se pudo mantener una autorización de canal.');
    }
  }
  async function tick() {
    if (stopped || running) return;
    running = (async () => {
      for (const channel of ['instagram', 'facebook'])
        for (const config of registry.all(channel)) {
          if (stopped) break;
          const checked = Date.parse(config.checkedAt || '') || 0;
          if (
            channel === 'instagram' &&
            ((!config.tokenInfo && now() - checked < 86400_000) ||
              (config.nextRefreshAt && config.nextRefreshAt > now()))
          )
            continue;
          if (channel === 'facebook' && now() - checked < 86400_000) continue;
          await process(config);
        }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }
  return {
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => void tick(), 60000);
        timer.unref();
        void tick();
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
