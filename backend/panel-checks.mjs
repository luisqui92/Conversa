import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { openStore } from './store.mjs';
import { makeServer } from './server.mjs';
import { openFacebookAutomation, createFacebookWorker } from './facebook-automation.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';
import { buildLiveActivity, escapeLive } from '../dist/live-panel.mjs';

test('Panel real: permisos, cambios concurrentes y cola de envíos', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-panel-')), path = join(dir, 'test.sqlite');
  let now = Date.now();
  const store = openStore(path, { now: () => now });
  store.setPassword('owner@example.test', 'panel-password-test', true);
  store.setPassword('other@example.test', 'other-password-test', true);
  const owner = store.userByEmail('owner@example.test');
  const config = { accountId: '309667913276491', username: 'Test page', ownerId: owner.id, accessToken: 'never-expose-token', appSecret: 'never-expose-secret', verifyToken: 'never-expose-verifier' };
  const instagramConfig = { ...config, accountId: '17841456943841038', username: 'test_ig' };
  const fb = openFacebookAutomation(path, { now: () => now }), ig = openInstagramAutomation(path, { now: () => now });
  const server = makeServer({ store, facebook: () => config, facebookAutomation: fb, instagram: () => instagramConfig, automation: ig });
  const session = store.login('owner@example.test', 'panel-password-test', 'test');
  const other = store.login('other@example.test', 'other-password-test', 'test');
  const route = '/api/integrations/facebook/automation', mediaId = config.accountId + '_123456789012345';
  const input = { mediaId, publicText: '{autor} Te mandé información.', dmText: 'Hola, aquí está.', enabled: true, expectedVersion: null };
  function request(method, url, input, token = session.token, headers = {}) {
    return new Promise(resolve => {
      const req = Readable.from([Buffer.from(input === undefined ? '' : JSON.stringify(input))]);
      Object.assign(req, { method, url, headers: { origin: 'https://cc.chatgo.ia.bo', 'content-type': 'application/json', ...(token ? { cookie: '__Host-conversa=' + token } : {}), ...headers }, socket: { remoteAddress: 'test' } });
      const res = { headersSent: false, destroyed: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
      server.emit('request', req, res);
    });
  }
  const comment = id => ({ id: config.accountId, time: Math.floor(now / 1000), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: mediaId, parent_id: mediaId, comment_id: '123456789012345_' + id, created_time: Math.floor(now / 1000), from: { id: '555555555555', name: 'Test author' }, message: '<img src=x onerror=alert(1)>' } }] });
  try {
    await t.test('No permite editar sin sesión, desde otro origen, con otro tipo de contenido o usuario ajeno', async () => {
      assert.equal((await request('PUT', route, input, null)).status, 401);
      assert.equal((await request('PUT', route, input, session.token, { origin: 'https://other.test' })).status, 403);
      assert.equal((await request('PUT', route, input, session.token, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await request('PUT', route, input, other.token)).status, 404);
      assert.equal(fb.report(owner.id).rules.length, 0);
    });
    await t.test('Valida mensajes, IDs y página sin modificar las reglas', async () => {
      for (const bad of [{ ...input, mediaId: 'http://evil.test' }, { ...input, mediaId: '9999999999_12345678' }, { ...input, publicText: '' }, { ...input, dmText: 'x'.repeat(1001) }, { ...input, enabled: 'true' }, { ...input, expectedVersion: undefined }]) assert.equal((await request('PUT', route, bad)).status, 422);
      assert.equal(fb.report(owner.id).rules.length, 0);
    });
    let report;
    await t.test('Crea y consulta una regla con versión sin exponer credenciales ni afectar Instagram', async () => {
      const created = await request('PUT', route, input); assert.equal(created.status, 200); report = created.body;
      assert.match(report.rules[0].version, /^[a-f0-9]{64}$/);
      assert.equal(report.summary.total, 0); assert.equal(ig.report(owner.id).rules.length, 0);
      for (const secret of [config.accessToken, config.appSecret, config.verifyToken]) assert.ok(!JSON.stringify(report).includes(secret));
      assert.deepEqual((await request('GET', route, undefined, other.token)).body, { rules: [], actions: [] });
    });
    await t.test('Un conflicto no sobrescribe y una pausa invalida la versión de la pestaña anterior', async () => {
      assert.equal((await request('PUT', route, { ...input, dmText: 'No sobrescribir' })).status, 409);
      const version = report.rules[0].version;
      const paused = await request('PUT', route, { ...input, enabled: false, expectedVersion: version });
      assert.equal(paused.status, 200); assert.equal(paused.body.rules[0].enabled, 0);
      assert.notEqual(paused.body.rules[0].version, version);
      assert.equal((await request('PUT', route, { ...input, expectedVersion: version })).status, 409);
      report = (await request('PUT', route, { ...input, expectedVersion: paused.body.rules[0].version })).body;
    });
    await t.test('El webhook usa los mensajes guardados desde el panel y respeta público antes de DM', async () => {
      now += 1000;
      const entry = comment('987654321012345'), body = JSON.stringify({ object: 'page', entry: [entry] });
      const req = Readable.from([Buffer.from(body)]);
      Object.assign(req, { method: 'POST', url: '/api/webhooks/facebook', headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', config.appSecret).update(body).digest('hex') }, socket: { remoteAddress: 'test' } });
      await new Promise(resolve => server.emit('request', req, { headersSent: false, destroyed: false, writeHead(status) { assert.equal(status, 200); }, end() { resolve(); } }));
      const calls = [], worker = createFacebookWorker({ automation: fb, facebook: () => config, request: async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => url.endsWith('/comments') ? { id: 'public-id' } : { message_id: 'dm-id' } }; } });
      await worker.tick(); assert.equal(calls.length, 1); assert.equal(calls[0].message, '@[555555555555] Te mandé información.');
      await worker.tick(); assert.equal(calls.length, 2); assert.equal(calls[1].message.text, input.dmText);
      report = (await request('GET', route)).body;
      assert.equal(report.summary.total, 1); assert.equal(report.summary.publicConfirmed, 1); assert.equal(report.summary.dmConfirmed, 1);
      assert.equal(report.actions[0].public_text, calls[0].message);
    });
    await t.test('Pausar cancela pendientes sin duplicar resultados y las métricas cuentan más de 20 filas', async () => {
      now += 1000;
      for (let n = 0; n < 24; n++) fb.enqueue(config, [comment(String(888888880000000 + n))]);
      const updated = await request('PUT', route, { ...input, enabled: false, expectedVersion: report.rules[0].version });
      assert.equal(updated.status, 200); assert.equal(fb.claim(config), null);
      const result = (await request('GET', route)).body;
      assert.equal(result.summary.total, 25); assert.equal(result.actions.length, 20); assert.equal(result.summary.pending, 0); assert.equal(result.summary.dmConfirmed, 1);
      now += 8 * 86400_000;
      assert.equal(fb.panelReport(owner.id, config.accountId).summary.total, 0);
      now -= 8 * 86400_000;
    });
    await t.test('Instagram guarda y pausa sus propias reglas sin modificar Facebook', async () => {
      const result = await request('PUT', '/api/integrations/instagram/automation', { ...input, mediaId: '17968502288460067', publicText: 'Te mandé info al DM.' });
      assert.equal(result.status, 200); assert.equal(result.body.rules[0].enabled, 1);
      const paused = await request('PUT', '/api/integrations/instagram/automation', { ...input, mediaId: '17968502288460067', publicText: 'Te mandé info al DM.', enabled: false, expectedVersion: result.body.rules[0].version });
      assert.equal(paused.status, 200); assert.equal(paused.body.rules[0].enabled, 0);
      assert.equal(fb.report(owner.id).rules[0].enabled, 0);
    });
  } finally { fb.close(); ig.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Actividad: une IDs, separa canales, descarta ecos y muestra mensajes entrantes sin inventar envíos', () => {
  const action = { account_id: '11111111', comment_id: '88888888_99999999', media_id: '11111111_88888888', status: 'sent', public_id: 'public', message_id: 'private', created_at: 123 };
  const channel = { account: { configured: true, accountId: '11111111' }, report: { actions: [action] }, events: { events: [{ receivedAt: 123, entry: { id: '11111111', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: '99999999', from: { id: '22222222', name: '<script>bad</script>' }, message: 'Hola' } }], messaging: [{ sender: { id: '22222222' }, message: { mid: 'incoming', text: 'Gracias' } }, { sender: { id: '11111111' }, message: { mid: 'echo', is_echo: true, text: 'Not incoming' } }] } }] } };
  const list = buildLiveActivity({ facebook: channel, instagram: { ...channel, account: { configured: false } } });
  assert.equal(list.length, 2); assert.equal(list.find(a => a.kind === 'comment').author, '<script>bad</script>');
  assert.equal(list.find(a => a.kind === 'comment').status, 'sent');
  assert.equal(list.find(a => a.kind === 'message').status, 'incoming');
  assert.equal(escapeLive('<script>bad</script>'), '&lt;script&gt;bad&lt;/script&gt;');
  assert.equal(buildLiveActivity({ facebook: { ...channel, account: { configured: true, accountId: '33333333' } } }).length, 0);
});
