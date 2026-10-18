import { randomBytes, createHash } from 'node:crypto';
import { seal, unseal } from './channel-accounts.mjs';
import { inspectInstagramToken, graphOrigin } from './instagram-connection.mjs';
import { exchangeFacebookUserToken, inspectFacebookPageToken } from './facebook-token.mjs';
import {
  facebookGraph,
  resolveFacebookPage,
  subscribeFacebookPage,
} from './facebook-connection.mjs';
const hash = (value) =>
  createHash('sha256')
    .update(value || '')
    .digest('hex');
const cookie = (req, name) =>
  String(req.headers.cookie || '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + '='))
    ?.slice(name.length + 1);
const cookieName = (channel) => '__Host-conversa_oauth_' + channel;

export function createOAuth({ store, registry, key, origin, request = fetch, now = Date.now }) {
  const db = store.database,
    base = new URL(origin).origin;
  if (!base.startsWith('https://')) throw new Error('OAuth requiere HTTPS.');
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_states(state_hash TEXT PRIMARY KEY,channel TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
    session_hash TEXT NOT NULL,proof_hash TEXT NOT NULL,app_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_selections(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),channel TEXT NOT NULL,
    encrypted_data TEXT NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(user_id,channel));`);
  const redirect = (channel) => base + '/api/oauth/' + channel + '/callback';
  function send(res, status, value) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
  function cleanup() {
    db.prepare('DELETE FROM oauth_states WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM oauth_selections WHERE expires_at<=?').run(now());
  }
  async function json(url, options = {}) {
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
      throw new Error('No se pudo contactar con Meta. Intenta conectar nuevamente.');
    }
    if (!response.ok || data?.error)
      throw new Error(
        'Meta no concedió el acceso necesario. Revisa los permisos y el estado de revisión de la aplicación.',
      );
    return data;
  }
  const form = (url, values) =>
    json(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
    });
  async function subscribeInstagram(config) {
    const result = await formWithToken(
      graphOrigin + '/' + config.accountId + '/subscribed_apps',
      config.accessToken,
      { subscribed_fields: 'comments,messages' },
    );
    if (result.success !== true) throw new Error('Meta no confirmó la suscripción de la cuenta.');
  }
  const formWithToken = (url, token, values) =>
    json(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(values).toString(),
    });
  async function readInput(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw new Error('Solicitud demasiado grande.');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new Error('Solicitud no válida.');
    }
  }
  function finish(res, channel, result) {
    res.writeHead(303, {
      'Cache-Control': 'no-store',
      Location: base + '/?oauth=' + result + '&channel=' + channel + '#connections',
      'Set-Cookie': cookieName(channel) + '=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    });
    res.end();
  }
  return {
    async authenticated(req, res, url, user) {
      cleanup();
      try {
        if (req.method === 'GET' && url.pathname === '/api/oauth/status')
          return send(res, 200, {
            instagram: !!registry.app('instagram'),
            facebook: !!registry.app('facebook'),
          });
        const route = /^\/api\/oauth\/(instagram|facebook)\/(start|pages|connect-page)$/.exec(
          url.pathname,
        );
        if (!route) return send(res, 404, { error: 'Ruta no disponible.' });
        const [, channel, action] = route,
          app = registry.app(channel);
        if (!app)
          return send(res, 503, {
            error: 'El administrador debe configurar la conexión con Meta antes de continuar.',
          });
        if (action === 'start' && req.method === 'POST') {
          await readInput(req);
          const state = randomBytes(32).toString('hex'),
            proof = randomBytes(32).toString('hex');
          const session = cookie(req, '__Host-conversa');
          db.prepare('INSERT INTO oauth_states VALUES (?,?,?,?,?,?,?)').run(
            hash(state),
            channel,
            user.id,
            hash(session),
            hash(proof),
            app.appId,
            now() + 10 * 60000,
          );
          const query = new URLSearchParams({
            client_id: app.appId,
            redirect_uri: redirect(channel),
            response_type: 'code',
            state,
            scope:
              channel === 'facebook'
                ? 'pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_engagement,pages_manage_metadata,pages_messaging'
                : 'instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages',
          });
          if (channel === 'facebook' && app.configId) query.set('config_id', app.configId);
          if (channel === 'instagram') {
            query.set('enable_fb_login', '0');
            query.set('force_authentication', '1');
          }
          const authorizationUrl =
            (channel === 'facebook'
              ? 'https://www.facebook.com/v26.0/dialog/oauth'
              : 'https://www.instagram.com/oauth/authorize') +
            '?' +
            query;
          res.setHeader(
            'Set-Cookie',
            cookieName(channel) +
              '=' +
              proof +
              '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600',
          );
          return send(res, 200, { url: authorizationUrl });
        }
        if (channel === 'facebook' && ['pages', 'connect-page'].includes(action)) {
          const grant = db
            .prepare(
              'SELECT * FROM oauth_selections WHERE user_id=? AND channel=? AND expires_at>?',
            )
            .get(user.id, channel, now());
          if (!grant)
            return action === 'pages'
              ? send(res, 200, { pages: [] })
              : send(res, 409, { error: 'La autorización venció. Conecta Facebook nuevamente.' });
          const data = unseal(grant.encrypted_data, key, 'selection:' + grant.id + ':' + user.id);
          if (action === 'pages' && req.method === 'GET')
            return send(res, 200, { pages: data.pages.map((p) => ({ id: p.id, name: p.name })) });
          if (action === 'connect-page' && req.method === 'POST') {
            const input = await readInput(req);
            if (!data.pages.some((p) => p.id === input.pageId))
              return send(res, 422, { error: 'Selecciona una de las páginas autorizadas.' });
            const page = await resolveFacebookPage(data.accessToken, input.pageId, request);
            const tokenInfo = await inspectFacebookPageToken(
              { ...page, appId: app.appId, appSecret: app.appSecret },
              request,
              now,
            );
            if (
              !tokenInfo.valid ||
              tokenInfo.expiresAt === null ||
              (tokenInfo.expiresAt > 0 && tokenInfo.expiresAt * 1000 <= now() + 86400_000) ||
              (tokenInfo.dataAccessExpiresAt > 0 && tokenInfo.dataAccessExpiresAt * 1000 <= now())
            )
              throw new Error('La autorización de la página no está vigente.');
            const existing = registry.lookup(channel, page.accountId);
            if (existing && existing.ownerId !== user.id)
              return send(res, 409, {
                error: 'La página ya está conectada a otro negocio de Conversa.',
              });
            const saved = registry.put(
              channel,
              {
                ...page,
                ownerId: user.id,
                ownerEmail: user.email,
                appId: app.appId,
                appSecret: app.appSecret,
                verifyToken: app.verifyToken,
                tokenInfo,
                checkedAt: tokenInfo.checkedAt,
              },
              { expectedVersion: existing?.version || 0 },
            );
            try {
              await subscribeFacebookPage(saved, request);
            } catch {
              // Keep the authorized account visible so the user can reconnect; never silently report a working webhook.
              registry.put(
                channel,
                {
                  ...saved,
                  subscriptionError: 'Meta no confirmó la suscripción. Reconecta la cuenta.',
                },
                { expectedVersion: saved.version },
              );
              return send(res, 200, {
                connected: true,
                warning:
                  'La cuenta se guardó, pero Meta no confirmó los eventos. Reconecta para completar la conexión.',
              });
            }
            data.pages = data.pages.filter((p) => p.id !== input.pageId);
            if (!data.pages.length)
              db.prepare('DELETE FROM oauth_selections WHERE id=? AND user_id=?').run(
                grant.id,
                user.id,
              );
            else
              db.prepare(
                'UPDATE oauth_selections SET encrypted_data=? WHERE id=? AND user_id=?',
              ).run(seal(data, key, 'selection:' + grant.id + ':' + user.id), grant.id, user.id);
            return send(res, 200, { connected: true });
          }
        }
        return send(res, 405, { error: 'Método no permitido.' });
      } catch (error) {
        send(res, 422, {
          error: [
            'Meta ',
            'No se pudo contactar',
            'La autorización',
            'La página',
            'Solicitud',
          ].some((p) => error.message.startsWith(p))
            ? error.message
            : 'No se pudo completar la conexión. Intenta nuevamente.',
        });
      }
    },
    async callback(req, res, url) {
      cleanup();
      const channel = /\/oauth\/(instagram|facebook)\//.exec(url.pathname)?.[1];
      if (!channel || req.method !== 'GET')
        return send(res, 405, { error: 'Método no permitido.' });
      const state = url.searchParams.get('state') || '',
        proof = cookie(req, cookieName(channel)) || '';
      if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(proof))
        return send(res, 403, {
          error: 'La autorización no corresponde a este navegador. Inicia la conexión otra vez.',
        });
      const record = db
        .prepare(
          `DELETE FROM oauth_states WHERE state_hash=? AND proof_hash=? AND channel=? AND expires_at>?
        AND EXISTS(SELECT 1 FROM sessions WHERE hash=oauth_states.session_hash AND user_id=oauth_states.user_id AND expires_at>?) RETURNING *`,
        )
        .get(hash(state), hash(proof), channel, now(), now());
      if (!record)
        return send(res, 403, {
          error: 'La autorización venció o ya fue utilizada. Inicia la conexión otra vez.',
        });
      try {
        if (url.searchParams.has('error')) return finish(res, channel, 'denied');
        const code = url.searchParams.get('code');
        if (!code || code.length > 8192) throw new Error();
        const app = registry.app(channel);
        if (!app || app.appId !== record.app_id) throw new Error();
        if (channel === 'facebook') {
          const result = await form(facebookGraph + '/oauth/access_token', {
            client_id: app.appId,
            client_secret: app.appSecret,
            redirect_uri: redirect(channel),
            code,
          });
          const extended = await exchangeFacebookUserToken(
            { userToken: result.access_token, appId: app.appId, appSecret: app.appSecret },
            request,
          );
          const pages = await json(facebookGraph + '/me/accounts?fields=id,name,tasks&limit=100', {
            headers: { Authorization: 'Bearer ' + extended.accessToken },
          });
          const available = (pages.data || []).filter(
            (p) => p.tasks?.includes('MODERATE') && p.tasks?.includes('MESSAGING'),
          );
          if (!available.length) throw new Error();
          const id = randomBytes(24).toString('hex');
          db.prepare(
            `INSERT INTO oauth_selections VALUES (?,?,?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET id=excluded.id,encrypted_data=excluded.encrypted_data,expires_at=excluded.expires_at`,
          ).run(
            id,
            record.user_id,
            channel,
            seal(
              { accessToken: extended.accessToken, pages: available },
              key,
              'selection:' + id + ':' + record.user_id,
            ),
            now() + 10 * 60000,
          );
          return finish(res, channel, 'choose-facebook');
        }
        const initial = await form('https://api.instagram.com/oauth/access_token', {
          client_id: app.appId,
          client_secret: app.appSecret,
          grant_type: 'authorization_code',
          redirect_uri: redirect(channel),
          code,
        });
        const exchanged = await json(
          'https://graph.instagram.com/access_token?' +
            new URLSearchParams({
              grant_type: 'ig_exchange_token',
              client_secret: app.appSecret,
              access_token: initial.access_token,
            }),
        );
        if (
          typeof exchanged.access_token !== 'string' ||
          !Number.isSafeInteger(exchanged.expires_in) ||
          exchanged.expires_in <= 86400
        )
          throw new Error();
        const profile = await inspectInstagramToken(exchanged.access_token, request);
        const previous = registry.lookup(channel, profile.accountId);
        if (previous && previous.ownerId !== record.user_id)
          return finish(res, channel, 'account-in-use');
        const checkedAt = new Date(now()).toISOString();
        const saved = registry.put(
          channel,
          {
            ...profile,
            ownerId: record.user_id,
            accessToken: exchanged.access_token,
            appSecret: app.appSecret,
            appId: app.appId,
            verifyToken: app.verifyToken,
            checkedAt,
            tokenInfo: {
              valid: true,
              checkedAt,
              expiresAt: Math.floor(now() / 1000) + exchanged.expires_in,
              dataAccessExpiresAt: null,
            },
            nextRefreshAt: now() + Math.max(86400, exchanged.expires_in - 15 * 86400) * 1000,
          },
          { expectedVersion: previous?.version || 0 },
        );
        try {
          await subscribeInstagram(saved);
        } catch {
          registry.put(
            channel,
            {
              ...saved,
              subscriptionError: 'Meta no confirmó la suscripción. Reconecta la cuenta.',
            },
            { expectedVersion: saved.version },
          );
          return finish(res, channel, 'subscription-pending');
        }
        finish(res, channel, 'connected');
      } catch {
        finish(res, channel, 'error');
      }
    },
  };
}
