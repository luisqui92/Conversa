import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { openStore } from './store.mjs';
import { makeServer } from './server.mjs';
import { inspectInstagramToken, readInstagram, writeInstagram } from './instagram-connection.mjs';

function request(server, method, url, body = '', headers = {}) {
  return new Promise(resolve => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
    const res = { headersSent: false, destroyed: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); } };
    server.emit('request', req, res);
  });
}
test('Conexión piloto de Instagram y aislamiento de webhooks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'conversa-instagram-'));
  let now = Date.now();
  const store = openStore(join(directory, 'test.sqlite'), { now: () => now });
  store.setPassword('owner@example.test', 'test-password-123', true);
  store.setPassword('other@example.test', 'test-password-456', true);
  const owner = store.userByEmail('owner@example.test');
  const config = { ownerId: owner.id, ownerEmail: owner.email, accountId: '17841456943841038', username: 'test_only',
    verifyToken: 'test-only-verification', appSecret: '0123456789abcdef0123456789abcdef', accessToken: 'test-only-access', checkedAt: new Date(now).toISOString() };
  const path = join(directory, 'instagram.credentials.json');
  let server = makeServer({ store, instagram: () => readInstagram(path) });
  const callback = '/api/webhooks/instagram';
  const payload = { object: 'instagram', entry: [{ id: config.accountId, time: 123, changes: [{ field: 'comments', value: { id: 'comment-test', text: 'precio' } }] }] };
  const signed = value => {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    return [body, { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', config.appSecret).update(body).digest('hex') }];
  };
  const ownerSession = store.login('owner@example.test', 'test-password-123', 'test');
  const otherSession = store.login('other@example.test', 'test-password-456', 'test');
  const cookie = session => ({ cookie: `__Host-conversa=${session.token}` });
  try {
    await t.test('Antes de configurar no confirma una conexión inexistente', async () => {
      assert.equal((await request(server, 'GET', callback)).status, 503);
    });
    await t.test('Guarda secretos fuera del frontend con permiso 600', () => {
      writeInstagram(path, config);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readInstagram(path), config);
      writeInstagram(path, { ...config, username: 'test_updated' });
      assert.equal(readInstagram(path).username, 'test_updated');
    });
    await t.test('La verificación exige el token y devuelve el challenge exacto como texto', async () => {
      assert.equal((await request(server, 'GET', callback + '?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status, 403);
      const result = await request(server, 'GET', callback + '?hub.mode=subscribe&hub.verify_token=' + config.verifyToken + '&hub.challenge=12345');
      assert.equal(result.status, 200); assert.equal(result.body, '12345');
      assert.ok(result.headers['Content-Type'].startsWith('text/plain'));
    });
    await t.test('Rechaza firmas ausentes, inválidas y contenido alterado antes de persistir', async () => {
      const [body, headers] = signed(payload);
      assert.equal((await request(server, 'POST', callback, body)).status, 403);
      assert.equal((await request(server, 'POST', callback, body + ' ', headers)).status, 403);
      assert.equal(store.instagramEventCount(owner.id), 0);
    });
    await t.test('Eventos auténticos se guardan una vez, sin Origin ni cookie, y filtran otras cuentas', async () => {
      const [body, headers] = signed(payload);
      assert.equal((await request(server, 'POST', callback, body, headers)).status, 200);
      assert.equal((await request(server, 'POST', callback, body, headers)).status, 200);
      const [mixed, mixedHeaders] = signed({ ...payload, entry: [...payload.entry, { id: '99999999', changes: [{ field: 'comments' }] }] });
      assert.equal((await request(server, 'POST', callback, mixed, mixedHeaders)).status, 200);
      assert.equal(store.instagramEventCount(owner.id), 1);
      assert.equal(store.readInstagramEvents(owner.id)[0].entry.id, config.accountId);
    });
    await t.test('Estado y eventos requieren sesión; no exponen credenciales ni datos ajenos', async () => {
      const status = '/api/integrations/instagram';
      assert.equal((await request(server, 'GET', status)).status, 401);
      const own = await request(server, 'GET', status, '', cookie(ownerSession));
      assert.equal(JSON.parse(own.body).configured, true);
      assert.ok(!own.body.includes(config.accessToken)); assert.ok(!own.body.includes(config.appSecret)); assert.ok(!own.body.includes(config.verifyToken));
      const other = await request(server, 'GET', status, '', cookie(otherSession));
      assert.deepEqual(JSON.parse(other.body), { configured: false });
      assert.deepEqual(JSON.parse((await request(server, 'GET', status + '/events?userId=' + owner.id, '', cookie(otherSession))).body), { events: [] });
      assert.equal(JSON.parse((await request(server, 'GET', status + '/events', '', cookie(ownerSession))).body).events.length, 1);
    });
    await t.test('Rechaza payload inválido y limita cuerpos; no registra basura firmada', async () => {
      for (const invalid of ['null', '{', JSON.stringify({ object: 'page', entry: [] })]) {
        const [body, headers] = signed(invalid);
        assert.equal((await request(server, 'POST', callback, body, headers)).status, 400);
      }
      assert.equal((await request(server, 'POST', callback, 'x'.repeat(1024 * 1024 + 1))).status, 413);
      assert.equal(store.instagramEventCount(owner.id), 1);
    });
    await t.test('Los eventos dejan de mostrarse después de siete días y se eliminan al recibir nuevos', () => {
      now += 8 * 86400_000;
      assert.equal(store.instagramEventCount(owner.id), 0);
      assert.deepEqual(store.readInstagramEvents(owner.id), []);
      store.recordInstagramEntries(owner.id, [{ id: config.accountId, time: 456 }]);
      assert.equal(store.instagramEventCount(owner.id), 1);
    });
    await t.test('Validar token usa Authorization, no parámetros URL; errores no incluyen secretos', async () => {
      const profile = await inspectInstagramToken('test-only-token', async (url, options) => {
        assert.ok(!url.includes('test-only-token'));
        assert.equal(options.headers.Authorization, 'Bearer test-only-token');
        return { ok: true, json: async () => ({ user_id: config.accountId, username: config.username }) };
      });
      assert.equal(profile.accountId, config.accountId);
      await assert.rejects(inspectInstagramToken('test-only-token', async () => ({ ok: false })), /Instagram rechazó/);
    });
  } finally { server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
