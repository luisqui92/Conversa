import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { openStore } from './store.mjs';
import { makeServer } from './server.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';
import { openFacebookAutomation } from './facebook-automation.mjs';
import { notificationCopy } from '../dist/notifications.mjs';

test('Notificaciones: confirmación, deduplicación, lectura y aislamiento', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-notifications-')), path = join(dir, 'test.sqlite');
  let now = Date.now();
  const store = openStore(path, { now: () => now });
  store.setPassword('owner@example.test', 'notification-password', true); store.setPassword('other@example.test', 'notification-other', true);
  const owner = store.userByEmail('owner@example.test'), session = store.login(owner.email, 'notification-password', 'test');
  const other = store.login('other@example.test', 'notification-other', 'test');
  const config = { accountId: '17841456943841038', username: 'test_ig', ownerId: owner.id, accessToken: 'do-not-expose-token', appSecret: 'do-not-expose-secret' };
  const fbConfig = { ...config, accountId: '309667913276491', username: 'Test page' };
  let ig = openInstagramAutomation(path, { now: () => now }); const fb = openFacebookAutomation(path, { now: () => now });
  let connected = config;
  let server = makeServer({ store, instagram: () => connected, automation: ig, facebook: () => fbConfig, facebookAutomation: fb });
  const accounts = [{ channel: 'instagram', accountId: config.accountId }, { channel: 'facebook', accountId: fbConfig.accountId }];
  function request(method, url, value, token = session.token, headers = {}) {
    return new Promise(resolve => {
      const req = Readable.from([Buffer.from(value === undefined ? '' : JSON.stringify(value))]);
      Object.assign(req, { method, url, headers: { origin: 'https://cc.chatgo.ia.bo', 'content-type': 'application/json', ...(token ? { cookie: '__Host-conversa=' + token } : {}), ...headers }, socket: { remoteAddress: 'test' } });
      server.emit('request', req, { headersSent: false, destroyed: false, writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } });
    });
  }
  const feed = () => store.notificationFeed(owner.id, accounts);
  let seq = 0;
  function enqueue(channel = 'instagram') {
    seq++; now += 1000;
    const queue = channel === 'instagram' ? ig : fb, account = channel === 'instagram' ? config : fbConfig;
    const media = channel === 'instagram' ? '17968502288460067' : account.accountId + '_1554451656687306';
    const id = String(18124786663917000n + BigInt(seq));
    queue.enable(account, media, 'Te mandé información.', 'Aquí están los detalles.');
    now += 1000;
    const entry = { id: account.accountId, time: Math.floor(now / 1000), changes: [{ field: channel === 'instagram' ? 'comments' : 'feed', value: channel === 'instagram' ? { id, from: { id: '555555555555' }, media: { id: media }, text: 'Hola' } : { item: 'comment', verb: 'add', comment_id: media.split('_')[1] + '_' + id, post_id: media, parent_id: media, from: { id: '555555555555' }, message: 'Hola', created_time: Math.floor(now / 1000) } }] };
    queue.enqueue(account, [entry]); return { queue, account, entry, job: queue.claim(account) };
  }
  let first;
  try {
    await t.test('Sin avisos al recibir, encolar o confirmar solo la respuesta pública', () => {
      first = enqueue(); assert.equal(feed().unread, 0);
      first.queue.complete(first.job, 'public-1'); assert.equal(feed().notifications.length, 0);
    });
    await t.test('Solo confirma éxito tras ambas fases y no duplica con reentrega o ejecución repetida', () => {
      const dm = ig.claim(config); ig.complete(dm, 'private-1'); ig.complete(dm, 'private-1');
      assert.equal(ig.enqueue(config, [first.entry]), 0);
      assert.equal(feed().unread, 1); assert.equal(feed().notifications[0].status, 'sent');
      assert.equal(notificationCopy(feed().notifications[0]).tone, 'success');
    });
    await t.test('Los rechazos públicos, privados y las interrupciones generan avisos veraces', () => {
      const rejected = enqueue('facebook'); fb.fail(rejected.job, false, 'Safe error'); fb.fail(rejected.job, false, 'Safe error');
      const partial = enqueue(); ig.complete(partial.job, 'public-2'); ig.fail(ig.claim(config), false, 'Safe error');
      const uncertain = enqueue(); ig.complete(uncertain.job, 'public-3'); ig.claim(config); now += 61_000; assert.equal(ig.claim(config), null);
      assert.deepEqual(new Set(feed().notifications.map(n => n.status)), new Set(['sent', 'public_failed', 'dm_failed', 'dm_unknown']));
      assert.equal(feed().unread, 4);
    });
    await t.test('La API requiere sesión y no expone credenciales ni avisos de otra cuenta', async () => {
      assert.equal((await request('GET', '/api/notifications', undefined, null)).status, 401);
      const own = await request('GET', '/api/notifications'); assert.equal(own.status, 200); assert.equal(own.body.unread, 4);
      assert.deepEqual((await request('GET', '/api/notifications', undefined, other.token)).body, { unread: 0, lastId: 0, notifications: [] });
      for (const secret of [config.accessToken, config.appSecret, owner.id]) assert.ok(!JSON.stringify(own.body).includes(secret));
      const id = own.body.notifications[0].id;
      assert.equal((await request('GET', '/api/notifications/' + id, undefined, other.token)).status, 404);
      const detail = await request('GET', '/api/notifications/' + id); assert.equal(detail.status, 200); assert.equal(detail.body.action.status, 'dm_unknown');
      connected = { ...config, accountId: '111111111111111' };
      assert.equal((await request('GET', '/api/notifications')).body.notifications.length, 1);
      connected = config;
    });
    await t.test('Marcar lectura exige JSON y mismo origen; una cuenta ajena no cambia los avisos', async () => {
      const id = feed().notifications[0].id;
      assert.equal((await request('POST', '/api/notifications/read', { ids: [id] }, session.token, { origin: 'https://other.test' })).status, 403);
      assert.equal((await request('POST', '/api/notifications/read', { ids: [id] }, session.token, { 'content-type': 'text/plain' })).status, 415);
      await request('POST', '/api/notifications/read', { ids: [id] }, other.token); assert.equal(feed().unread, 4);
      for (const bad of [{}, { ids: [] }, { ids: [-1] }, { throughId: '1' }, { ids: [id], throughId: id }]) assert.equal((await request('POST', '/api/notifications/read', bad)).status, 422);
      assert.equal((await request('POST', '/api/notifications/read', { ids: [id] })).body.unread, 3);
      assert.ok(feed().notifications[0].read_at);
    });
    await t.test('Marcar todas usa el límite observado y conserva las que llegan durante la operación', async () => {
      const lastId = feed().lastId;
      const fresh = enqueue(); ig.complete(fresh.job, 'public-new'); ig.complete(ig.claim(config), 'private-new');
      const result = await request('POST', '/api/notifications/read', { throughId: lastId });
      assert.equal(result.body.unread, 1); assert.ok(result.body.lastId > lastId);
      assert.equal(result.body.notifications[0].read_at, null);
    });
    await t.test('Lecturas y avisos sobreviven reinicios y no se reconstruyen ni pierden al cerrar el panel', () => {
      ig.close(); ig = openInstagramAutomation(path, { now: () => now });
      server = makeServer({ store, instagram: () => config, automation: ig, facebook: () => fbConfig, facebookAutomation: fb });
      assert.equal(feed().notifications.length, 5); assert.equal(feed().unread, 1);
      const raw = new DatabaseSync(path); raw.exec('BEGIN;');
      const fresh = feed().notifications[0];
      raw.prepare('UPDATE instagram_actions SET status=? WHERE comment_id=?').run('dm_sending', fresh.comment_id);
      raw.prepare('UPDATE instagram_actions SET status=? WHERE comment_id=?').run('sent', fresh.comment_id);
      raw.exec('ROLLBACK;'); raw.close(); assert.equal(feed().notifications.length, 5);
    });
    await t.test('La migración no avisa éxitos antiguos y las lecturas caducan con sus avisos a siete días', () => {
      const raw = new DatabaseSync(path); raw.exec('DROP TRIGGER instagram_notify_result;');
      const prior = enqueue(); ig.complete(prior.job, 'public-old'); ig.complete(ig.claim(config), 'private-old');
      raw.close(); ig.close(); ig = openInstagramAutomation(path, { now: () => now });
      assert.equal(feed().notifications.length, 5);
      now += 8 * 86400_000;
      assert.equal(feed().unread, 0); assert.equal(feed().notifications.length, 0);
    });
  } finally { ig.close(); fb.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
