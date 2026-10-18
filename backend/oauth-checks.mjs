import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { openStore } from './store.mjs';
import { openChannelAccounts } from './channel-accounts.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';
import { openFacebookAutomation } from './facebook-automation.mjs';
import { createOAuth } from './oauth.mjs';
import { makeServer } from './server.mjs';
const ok = (value) => ({ ok: true, status: 200, json: async () => value });

test('Autorización de clientes: estado de un uso, navegador, sesión y separación de páginas', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-oauth-')),
    path = join(dir, 'test.sqlite'),
    key = randomBytes(32);
  let now = Date.now(),
    profile = '17841499999999999',
    failSubscription = false;
  const store = openStore(path, { now: () => now });
  store.setPassword('one@example.test', 'oauth-customer-one', true);
  store.setPassword('two@example.test', 'oauth-customer-two', true);
  const one = store.userByEmail('one@example.test'),
    two = store.userByEmail('two@example.test');
  const a = store.login(one.email, 'oauth-customer-one', 'test'),
    b = store.login(two.email, 'oauth-customer-two', 'test');
  const registry = openChannelAccounts(path, { key, now: () => now }),
    ig = openInstagramAutomation(path),
    fb = openFacebookAutomation(path);
  const appId = '39748148371443102',
    secret = 'a'.repeat(32),
    page = '309667913276491';
  registry.setApp('facebook', appId, { appSecret: secret, verifyToken: 'facebook-webhook' });
  registry.setApp('instagram', '1797199674816532', {
    appSecret: secret,
    verifyToken: 'instagram-webhook',
  });
  const requests = [];
  const provider = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('api.instagram.com/oauth/access_token'))
      return ok({ access_token: 'ig-short', user_id: profile });
    if (url.includes('graph.instagram.com/access_token?'))
      return ok({ access_token: 'ig-long-private-token', expires_in: 5184000 });
    if (url.includes('graph.instagram.com') && url.includes('/me?'))
      return ok({ user_id: profile, username: 'connected_business' });
    if (url.includes('/subscribed_apps'))
      return failSubscription
        ? { ok: false, status: 400, json: async () => ({ error: { code: 10, message: secret } }) }
        : ok({ success: true });
    if (url.includes('/oauth/access_token')) {
      const form = new URLSearchParams(options.body);
      assert.ok(!url.includes(secret));
      assert.equal(form.get('client_secret'), secret);
      return form.get('grant_type') === 'fb_exchange_token'
        ? ok({ access_token: 'fb-long-user-private-token', expires_in: 5184000 })
        : ok({ access_token: 'fb-short-user-private-token' });
    }
    if (url.includes('/me/accounts?'))
      return ok({
        data: [
          {
            id: page,
            name: 'Customer Page',
            tasks: ['MODERATE', 'MESSAGING'],
            access_token: 'fb-page-private-token',
          },
        ],
      });
    if (url.includes('/debug_token?'))
      return ok({
        data: {
          is_valid: true,
          app_id: appId,
          type: 'PAGE',
          profile_id: page,
          expires_at: 0,
          data_access_expires_at: Math.floor(now / 1000) + 90 * 86400,
        },
      });
    if (url.includes('/me?fields=id')) return ok({ id: page, name: 'Customer Page' });
    throw new Error('Unexpected provider call');
  };
  const oauth = createOAuth({
    store,
    registry,
    key,
    origin: 'https://cc.chatgo.ia.bo',
    request: provider,
    now: () => now,
  });
  const server = makeServer({ store, registry, oauth, automation: ig, facebookAutomation: fb });
  function http(method, url, value = '', session = a, proof = '') {
    return new Promise((resolve) => {
      const req = Readable.from([
        Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
      ]);
      Object.assign(req, {
        method,
        url,
        headers: {
          origin: 'https://cc.chatgo.ia.bo',
          'content-type': 'application/json',
          cookie: (session ? '__Host-conversa=' + session.token : '') + (proof ? '; ' + proof : ''),
        },
        socket: { remoteAddress: 'test' },
      });
      server.emit('request', req, {
        headersSent: false,
        destroyed: false,
        setHeader(name, value) {
          this.headers = { ...this.headers, [name]: value };
        },
        writeHead(status, headers) {
          this.status = status;
          this.headers = { ...this.headers, ...headers };
        },
        end(body) {
          let data;
          try {
            data = JSON.parse(body);
          } catch {
            data = body;
          }
          resolve({ status: this.status, headers: this.headers, body: data });
        },
      });
    });
  }
  async function start(channel, session = a) {
    const result = await http('POST', '/api/oauth/' + channel + '/start', {}, session);
    assert.equal(result.status, 200);
    const consent = new URL(result.body.url),
      state = consent.searchParams.get('state'),
      proof = result.headers['Set-Cookie'].split(';')[0];
    assert.equal(
      consent.searchParams.get('redirect_uri'),
      'https://cc.chatgo.ia.bo/api/oauth/' + channel + '/callback',
    );
    assert.ok(!result.body.url.includes(secret));
    return {
      state,
      proof,
      callback: '/api/oauth/' + channel + '/callback?state=' + state + '&code=test-code',
    };
  }
  try {
    await t.test('El inicio exige sesión y no devuelve secretos de la app', async () => {
      assert.equal((await http('POST', '/api/oauth/instagram/start', {}, null)).status, 401);
      const status = await http('GET', '/api/oauth/status');
      assert.deepEqual(status.body, { instagram: true, facebook: true });
    });
    await t.test(
      'Una cookie ajena no consume el estado y un callback válido conecta sin la cookie Strict',
      async () => {
        const flow = await start('instagram');
        assert.equal(
          (
            await http(
              'GET',
              flow.callback,
              '',
              null,
              '__Host-conversa_oauth_instagram=' + 'b'.repeat(64),
            )
          ).status,
          403,
        );
        const result = await http('GET', flow.callback, '', null, flow.proof);
        assert.equal(result.status, 303);
        assert.ok(result.headers.Location.includes('oauth=connected'));
        assert.equal(registry.list(one.id).length, 1);
        assert.equal(registry.list(two.id).length, 0);
        assert.equal(registry.lookup('instagram', profile).ownerId, one.id);
        assert.equal((await http('GET', flow.callback, '', null, flow.proof)).status, 403);
      },
    );
    await t.test('No se transfiere una cuenta social ya asignada a otro negocio', async () => {
      const flow = await start('instagram', b),
        result = await http('GET', flow.callback, '', null, flow.proof);
      assert.ok(result.headers.Location.includes('account-in-use'));
      assert.equal(registry.list(two.id).length, 0);
    });
    await t.test(
      'Facebook espera la elección de página y mantiene el token de usuario cifrado y temporal',
      async () => {
        const flow = await start('facebook');
        const result = await http('GET', flow.callback, '', null, flow.proof);
        assert.equal(result.status, 303);
        assert.ok(result.headers.Location.includes('choose-facebook'));
        assert.equal(registry.all('facebook').length, 0);
        const pages = await http('GET', '/api/oauth/facebook/pages');
        assert.deepEqual(pages.body.pages, [{ id: page, name: 'Customer Page' }]);
        assert.deepEqual((await http('GET', '/api/oauth/facebook/pages', '', b)).body.pages, []);
        assert.equal(
          (await http('POST', '/api/oauth/facebook/connect-page', { pageId: page }, b)).status,
          409,
        );
        assert.equal(
          (await http('POST', '/api/oauth/facebook/connect-page', { pageId: '11111111111' }))
            .status,
          422,
        );
        const encrypted = store.database
          .prepare('SELECT encrypted_data FROM oauth_selections')
          .get().encrypted_data;
        assert.ok(!encrypted.includes('fb-long-user-private-token'));
        const saved = await http('POST', '/api/oauth/facebook/connect-page', { pageId: page });
        assert.equal(saved.status, 200);
        assert.equal(saved.body.connected, true);
        assert.equal(registry.lookup('facebook', page).accessToken, 'fb-page-private-token');
        assert.equal(
          store.database.prepare('SELECT count(*) AS n FROM oauth_selections').get().n,
          0,
        );
      },
    );
    await t.test('Un estado vencido o cuya sesión se cerró no puede conectar', async () => {
      const expired = await start('instagram');
      now += 11 * 60000;
      assert.equal((await http('GET', expired.callback, '', null, expired.proof)).status, 403);
      const cancelled = await start('instagram', b);
      store.logout(b.token);
      assert.equal((await http('GET', cancelled.callback, '', null, cancelled.proof)).status, 403);
    });
    await t.test(
      'Un fallo de suscripción queda visible sin incluir cuerpos de error o secretos',
      async () => {
        profile = '17841488888888888';
        failSubscription = true;
        const flow = await start('instagram'),
          result = await http('GET', flow.callback, '', null, flow.proof);
        assert.ok(result.headers.Location.includes('subscription-pending'));
        const connected = registry.lookup('instagram', profile);
        assert.ok(connected.subscriptionError);
        assert.ok(!connected.subscriptionError.includes(secret));
      },
    );
  } finally {
    ig.close();
    fb.close();
    registry.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
