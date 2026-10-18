import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { openStore } from './store.mjs';
import { equalSecret, readInstagram, validSignature, rawBody } from './instagram-connection.mjs';
import { openInstagramAutomation, createInstagramWorker } from './instagram-automation.mjs';
import { readFacebook } from './facebook-connection.mjs';
import { facebookCredentialStatus } from './facebook-token.mjs';
import { openFacebookAutomation, createFacebookWorker } from './facebook-automation.mjs';
import { openChannelAccounts, loadMasterKey } from './channel-accounts.mjs';
import { createOAuth } from './oauth.mjs';
import { createCredentialMaintenance } from './credential-maintenance.mjs';

export function makeServer({
  store,
  origin = 'https://cc.chatgo.ia.bo',
  instagram = () => null,
  automation = null,
  facebook = () => null,
  facebookAutomation = null,
  registry = null,
  oauth = null,
  operations = null,
}) {
  const allowedOrigin = new URL(origin).origin;
  if (!allowedOrigin.startsWith('https://')) throw new Error('APP_ORIGIN debe usar HTTPS.');
  function send(res, code, value, headers = {}) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(JSON.stringify(value));
  }
  function token(req) {
    return String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('__Host-conversa='))
      ?.slice('__Host-conversa='.length);
  }
  function body(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0,
        rejected = false;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (rejected) return;
        if (size > limit) {
          rejected = true;
          chunks.length = 0;
          const error = new Error('El archivo supera el límite permitido.');
          error.status = 413;
          reject(error);
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          const error = new Error('JSON no válido.');
          error.status = 400;
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, allowedOrigin);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/health') {
        const workers = operations?.().workers || [];
        const ready = workers.every(
          (w) => w.lastTick && Date.now() - Date.parse(w.lastTick) < 60000,
        );
        return send(res, ready ? 200 : 503, { ok: ready });
      }
      if (path === '/api/webhooks/instagram' || path === '/api/webhooks/facebook') {
        const isFacebook = path === '/api/webhooks/facebook';
        const channel = isFacebook ? 'facebook' : 'instagram';
        const configs = registry
          ? registry.all(channel)
          : [isFacebook ? facebook() : instagram()].filter(Boolean);
        const app = registry?.app(channel);
        if (!configs.length && !app)
          return send(res, 503, { error: `${channel} todavía no está configurado.` });
        if (req.method === 'GET') {
          const challenge = url.searchParams.get('hub.challenge');
          if (
            url.searchParams.get('hub.mode') !== 'subscribe' ||
            ![app, ...configs]
              .filter(Boolean)
              .some((c) => equalSecret(url.searchParams.get('hub.verify_token'), c.verifyToken)) ||
            !challenge ||
            challenge.length > 1024
          )
            return send(res, 403, { error: 'Verificación no válida.' });
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          return res.end(challenge);
        }
        if (req.method !== 'POST')
          return send(res, 405, { error: 'Método no permitido.' }, { Allow: 'GET, POST' });
        const raw = await rawBody(req);
        if (
          ![app, ...configs]
            .filter(Boolean)
            .some((c) => validSignature(raw, req.headers['x-hub-signature-256'], c.appSecret))
        )
          return send(res, 403, { error: 'Firma no válida.' });
        let payload;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          return send(res, 400, { error: 'JSON no válido.' });
        }
        if (
          !payload ||
          payload.object !== (isFacebook ? 'page' : 'instagram') ||
          !Array.isArray(payload.entry) ||
          payload.entry.length > 100
        )
          return send(res, 400, { error: 'Evento de la plataforma no válido.' });
        // Entries from one HTTP delivery can belong to several independently owned accounts.
        for (const config of configs) {
          if (!validSignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) continue;
          const entries = payload.entry.filter(
            (entry) => entry && String(entry.id) === config.accountId,
          );
          if (!entries.length) continue;
          if (isFacebook) {
            store.recordFacebookEntries(config.ownerId, entries);
            facebookAutomation?.enqueue(config, entries);
          } else {
            store.recordInstagramEntries(config.ownerId, entries);
            automation?.enqueue(config, entries);
          }
        }
        return send(res, 200, { ok: true });
      }
      if (!['GET', 'POST', 'PUT'].includes(req.method))
        return send(res, 405, { error: 'Método no permitido.' }, { Allow: 'GET, POST, PUT' });
      if (req.method !== 'GET') {
        if (req.headers.origin !== allowedOrigin)
          return send(res, 403, { error: 'Origen no autorizado.' });
        if (!String(req.headers['content-type']).toLowerCase().startsWith('application/json'))
          return send(res, 415, { error: 'Se requiere application/json.' });
      }
      if (req.method === 'POST' && path === '/api/login') {
        const input = await body(req, 4096);
        if (
          !input ||
          typeof input !== 'object' ||
          typeof input.email !== 'string' ||
          typeof input.password !== 'string'
        )
          return send(res, 400, { error: 'Introduce correo y contraseña.' });
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress)
          .split(',')
          .at(-1)
          .trim();
        const result = store.login(input.email, input.password, ip);
        if (result?.limited)
          return send(
            res,
            429,
            { error: 'Demasiados intentos. Espera 15 minutos.' },
            { 'Retry-After': '900' },
          );
        if (!result) return send(res, 401, { error: 'Correo o contraseña incorrectos.' });
        store.logout(token(req));
        return send(
          res,
          200,
          { user: result.user },
          {
            'Set-Cookie': `__Host-conversa=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
          },
        );
      }
      if (oauth && /^\/api\/oauth\/(instagram|facebook)\/callback$/.test(path))
        return oauth.callback(req, res, url);
      const user = store.session(token(req));
      if (!user) return send(res, 401, { error: 'Inicia sesión para continuar.' });
      const ownConfigs = (channel) =>
        registry
          ? registry
              .list(user.id)
              .filter((a) => !channel || a.channel === channel)
              .map((a) => registry.get(a.id, user.id))
          : [
              { channel: 'instagram', config: instagram() },
              { channel: 'facebook', config: facebook() },
            ]
              .filter((a) => a.config?.ownerId === user.id && (!channel || a.channel === channel))
              .map((a) => ({ ...a.config, channel: a.channel }));
      function notificationAccounts() {
        return ownConfigs().map((c) => ({
          channel: c.channel,
          accountId: c.accountId,
          username: c.username,
        }));
      }
      function metadata(config) {
        const queue = config.channel === 'facebook' ? facebookAutomation : automation;
        const report = queue?.panelReport(config.ownerId, config.accountId);
        return {
          id: config.id,
          channel: config.channel,
          businessId: config.businessId,
          configured: true,
          username: config.username,
          accountId: config.accountId,
          enabled: config.enabled !== false,
          version: config.version,
          checkedAt: config.checkedAt,
          subscriptionError: config.subscriptionError || null,
          maintenance: registry?.maintenanceInfo(config.id) || null,
          receivedEvents:
            config.channel === 'facebook'
              ? store.facebookEventCount(config.ownerId, config.accountId)
              : store.instagramEventCount(config.ownerId, config.accountId),
          mode: report?.rules.some((r) => r.enabled) ? 'comment-then-dm' : 'receive-only',
          tokenHealth:
            config.channel === 'facebook'
              ? facebookCredentialStatus(config, report?.actions)
              : config.tokenInfo
                ? {
                    state:
                      config.tokenInfo.valid === false ||
                      (config.tokenInfo.expiresAt > 0 &&
                        config.tokenInfo.expiresAt * 1000 < Date.now())
                        ? 'reconnect'
                        : 'ok',
                    message: 'Vigencia registrada. La conexión puede ser revocada por Meta.',
                    ...config.tokenInfo,
                  }
                : null,
        };
      }
      if (oauth && path.startsWith('/api/oauth/')) return oauth.authenticated(req, res, url, user);
      if (registry && req.method === 'GET' && path === '/api/channel-accounts')
        return send(res, 200, {
          accounts: ownConfigs().map(metadata),
          business: registry.business(user.id),
        });
      const accountRoute =
        /^\/api\/channel-accounts\/([a-f0-9-]{36})(?:\/(automation|events))?$/.exec(path);
      if (registry && accountRoute) {
        const input = req.method === 'PUT' ? await body(req, 12000) : null;
        const config = registry.get(accountRoute[1], user.id);
        if (!config) return send(res, 404, { error: 'Cuenta no disponible.' });
        const queue = config.channel === 'facebook' ? facebookAutomation : automation;
        if (req.method === 'GET' && !accountRoute[2]) return send(res, 200, metadata(config));
        if (req.method === 'GET' && accountRoute[2] === 'events')
          return send(res, 200, {
            events:
              config.channel === 'facebook'
                ? store.readFacebookEvents(config.ownerId, config.accountId)
                : store.readInstagramEvents(config.ownerId, config.accountId),
          });
        if (accountRoute[2] === 'automation' && queue) {
          if (req.method === 'PUT') queue.saveRule(config, input);
          if (['GET', 'PUT'].includes(req.method))
            return send(
              res,
              200,
              queue.panelReport(config.ownerId, config.accountId, {
                days: Number(url.searchParams.get('days')) || 7,
              }),
            );
        }
        return send(res, 405, { error: 'Método no permitido.' });
      }
      if (registry && req.method === 'GET' && path === '/api/admin/operations') {
        if (!registry.isAdmin(user.id))
          return send(res, 403, { error: 'Acceso reservado al administrador.' });
        return send(res, 200, {
          ...(operations?.() || { workers: [] }),
          externalBackupConfigured: false,
        });
      }
      if (registry && path === '/api/admin/customers') {
        if (!registry.isAdmin(user.id))
          return send(res, 403, { error: 'Solo el administrador puede gestionar clientes.' });
        if (req.method === 'GET') return send(res, 200, { customers: registry.customers() });
        if (req.method === 'POST') {
          const input = await body(req, 4096);
          if (
            !input ||
            typeof input.name !== 'string' ||
            !input.name.trim() ||
            input.name.length > 100 ||
            typeof input.password !== 'string' ||
            input.password.length < 12 ||
            input.password.length > 256
          )
            return send(res, 422, {
              error: 'Indica el negocio, correo y una contraseña de al menos 12 caracteres.',
            });
          try {
            const created = store.setPassword(input.email, input.password, true, (created) =>
              registry.business(created.id, input.name.trim()),
            );
            return send(res, 201, { user: created, business: registry.business(created.id) });
          } catch (error) {
            return send(res, 422, {
              error: error.message.includes('UNIQUE')
                ? 'Ya existe una cuenta con ese correo.'
                : 'No se pudo crear el cliente. Revisa el correo y los datos.',
            });
          }
        }
      }
      function notificationFeed() {
        const accounts = notificationAccounts();
        const feed = store.notificationFeed(user.id, accounts);
        return {
          ...feed,
          notifications: feed.notifications.map((n) => ({
            ...n,
            accountName:
              accounts.find((a) => a.channel === n.channel && a.accountId === n.account_id)
                ?.username || '',
          })),
        };
      }
      if (req.method === 'GET' && path === '/api/notifications')
        return send(res, 200, notificationFeed());
      if (req.method === 'POST' && path === '/api/notifications/read') {
        const input = await body(req, 4096);
        store.markNotificationsRead(user.id, notificationAccounts(), input);
        return send(res, 200, notificationFeed());
      }
      const notificationRoute = /^\/api\/notifications\/([1-9][0-9]{0,15})$/.exec(path);
      if (req.method === 'GET' && notificationRoute) {
        const id = Number(notificationRoute[1]);
        if (!Number.isSafeInteger(id))
          return send(res, 404, { error: 'Notificación no disponible.' });
        const notification = store.notificationDetail(user.id, notificationAccounts(), id);
        if (!notification) return send(res, 404, { error: 'Notificación no disponible.' });
        const queue = notification.channel === 'facebook' ? facebookAutomation : automation;
        const action =
          queue?.notificationAction(user.id, notification.account_id, notification.comment_id) ||
          null;
        return send(res, 200, { notification, action });
      }
      const ruleRoute = /^\/api\/integrations\/(instagram|facebook)\/automation$/.exec(path);
      if (ruleRoute && req.method === 'PUT') {
        const input = await body(req, 12_000);
        // Re-read credentials after consuming the body: ownership can change during setup.
        const available = ownConfigs(ruleRoute[1]);
        if (available.length > 1)
          return send(res, 409, { error: 'Selecciona la cuenta desde Canales.' });
        const config = available[0];
        const queue = ruleRoute[1] === 'facebook' ? facebookAutomation : automation;
        if (!config || config.ownerId !== user.id || !queue)
          return send(res, 404, { error: 'Esta cuenta no tiene ese canal configurado.' });
        queue.saveRule(config, input);
        return send(res, 200, queue.panelReport(user.id, config.accountId));
      }
      if (req.method === 'GET' && path === '/api/integrations/instagram') {
        const available = ownConfigs('instagram');
        if (available.length > 1)
          return send(res, 409, { error: 'Selecciona una cuenta de Instagram.' });
        const config = available[0];
        if (!config || config.ownerId !== user.id) return send(res, 200, { configured: false });
        const active = automation
          ?.report(user.id)
          .rules.some((rule) => rule.enabled && rule.account_id === config.accountId);
        return send(res, 200, {
          configured: true,
          username: config.username,
          accountId: config.accountId,
          checkedAt: config.checkedAt,
          receivedEvents: store.instagramEventCount(user.id),
          mode: active ? 'comment-then-dm' : 'receive-only',
        });
      }
      if (req.method === 'GET' && path === '/api/integrations/instagram/events')
        return send(res, 200, { events: store.readInstagramEvents(user.id) });
      if (req.method === 'GET' && path === '/api/integrations/instagram/automation') {
        const available = ownConfigs('instagram');
        if (available.length > 1)
          return send(res, 409, { error: 'Selecciona una cuenta de Instagram.' });
        const config = available[0];
        return send(
          res,
          200,
          config?.ownerId === user.id && automation
            ? automation.panelReport(user.id, config.accountId)
            : { rules: [], actions: [] },
        );
      }
      if (req.method === 'GET' && path === '/api/integrations/facebook') {
        const available = ownConfigs('facebook');
        if (available.length > 1)
          return send(res, 409, { error: 'Selecciona una página de Facebook.' });
        const config = available[0];
        if (!config || config.ownerId !== user.id) return send(res, 200, { configured: false });
        const report = facebookAutomation?.report(user.id);
        const active = report?.rules.some(
          (rule) => rule.enabled && rule.account_id === config.accountId,
        );
        return send(res, 200, {
          configured: true,
          username: config.username,
          accountId: config.accountId,
          checkedAt: config.checkedAt,
          receivedEvents: store.facebookEventCount(user.id),
          mode: active ? 'comment-then-dm' : 'receive-only',
          tokenHealth: facebookCredentialStatus(config, report?.actions),
        });
      }
      if (req.method === 'GET' && path === '/api/integrations/facebook/events')
        return send(res, 200, { events: store.readFacebookEvents(user.id) });
      if (req.method === 'GET' && path === '/api/integrations/facebook/automation') {
        const available = ownConfigs('facebook');
        if (available.length > 1)
          return send(res, 409, { error: 'Selecciona una página de Facebook.' });
        const config = available[0];
        return send(
          res,
          200,
          config?.ownerId === user.id && facebookAutomation
            ? facebookAutomation.panelReport(user.id, config.accountId)
            : { rules: [], actions: [] },
        );
      }
      if (req.method === 'GET' && path === '/api/session')
        return send(res, 200, {
          user: { ...user, ...(registry ? { admin: registry.isAdmin(user.id) } : {}) },
        });
      if (req.method === 'POST' && path === '/api/logout') {
        store.logout(token(req));
        return send(
          res,
          200,
          { ok: true },
          {
            'Set-Cookie': '__Host-conversa=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
          },
        );
      }
      if (req.method === 'GET' && path === '/api/state')
        return send(res, 200, store.readState(user.id));
      if (req.method === 'PUT' && path === '/api/state') {
        const match = /^"(\d+)"$/.exec(String(req.headers['if-match'] || ''));
        if (!match || !Number.isSafeInteger(Number(match[1])))
          return send(res, 428, { error: 'Falta la versión del guardado. Recarga la página.' });
        const state = await body(req, 2 * 1024 * 1024);
        const result = store.writeState(user.id, Number(match[1]), state);
        if (result.invalid)
          return send(res, 422, {
            error: 'Los datos no tienen un formato válido para el servidor.',
          });
        if (result.conflict)
          return send(res, 409, {
            error:
              'Los datos cambiaron en otra pestaña. Exporta tus cambios y recarga antes de continuar.',
          });
        return send(res, 200, result);
      }
      return send(res, 404, { error: 'Ruta no disponible.' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        send(
          res,
          error.status || 500,
          { error: error.status ? error.message : 'No se pudo completar la operación.' },
          error.status === 413 ? { Connection: 'close' } : {},
        );
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
  const store = openStore(database);
  const automation = openInstagramAutomation(database);
  const facebookAutomation = openFacebookAutomation(database);
  const key = loadMasterKey(process.env.MASTER_KEY_PATH || '/run/conversa-keys/master.key');
  const registry = openChannelAccounts(database, { key });
  const instagram = () => registry.all('instagram'),
    facebook = () => registry.all('facebook');
  const worker = createInstagramWorker({
    automation,
    instagram,
    onError: (message) => console.error(message),
  });
  const facebookWorker = createFacebookWorker({
    automation: facebookAutomation,
    facebook,
    onError: (message) => console.error(message),
  });
  const maintenance = createCredentialMaintenance({
    registry,
    onError: (message) => console.error(message),
  });
  const origin = process.env.APP_ORIGIN || 'https://cc.chatgo.ia.bo';
  const oauth = createOAuth({ store, registry, key, origin });
  const server = makeServer({
    store,
    origin,
    registry,
    oauth,
    automation,
    facebookAutomation,
    operations: () => ({
      workers: [
        { channel: 'instagram', ...worker.status() },
        { channel: 'facebook', ...facebookWorker.status() },
      ],
    }),
  });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () =>
    console.log('Conversa API lista.'),
  );
  worker.start();
  facebookWorker.start();
  maintenance.start();
  process.on('SIGTERM', () =>
    server.close(async () => {
      await Promise.all([worker.stop(), facebookWorker.stop(), maintenance.stop()]);
      automation.close();
      facebookAutomation.close();
      registry.close();
      store.close();
      process.exit(0);
    }),
  );
}
