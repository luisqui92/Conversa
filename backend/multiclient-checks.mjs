import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store.mjs';
import { openChannelAccounts } from './channel-accounts.mjs';
import { openInstagramAutomation, createInstagramWorker } from './instagram-automation.mjs';
import { openFacebookAutomation } from './facebook-automation.mjs';
import { makeServer } from './server.mjs';
import { initialize } from './initialize.mjs';
import { restoreMigration } from './restore-migration.mjs';
import {
  refreshInstagramCredential,
  createCredentialMaintenance,
} from './credential-maintenance.mjs';

function http(server, method, url, value = '', headers = {}) {
  return new Promise((resolve) => {
    const body = typeof value === 'string' ? value : JSON.stringify(value),
      req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method, url, headers, socket: { remoteAddress: 'test' } });
    server.emit('request', req, {
      headersSent: false,
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) });
      },
    });
  });
}
const ok = (data) => ({ ok: true, status: 200, json: async () => data });

test('Varios clientes y cuentas del mismo canal: cifrado, propiedad y webhooks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-multiclient-')),
    path = join(dir, 'test.sqlite'),
    key = randomBytes(32);
  let now = Date.now();
  const store = openStore(path, { now: () => now });
  store.setPassword('one@example.test', 'customer-one-password', true);
  store.setPassword('two@example.test', 'customer-two-password', true);
  const one = store.userByEmail('one@example.test'),
    two = store.userByEmail('two@example.test');
  const registry = openChannelAccounts(path, { key, now: () => now }),
    ig = openInstagramAutomation(path, { now: () => now }),
    fb = openFacebookAutomation(path, { now: () => now });
  const first = registry.put('instagram', {
    ownerId: one.id,
    accountId: '17841411111111111',
    username: 'client_one',
    accessToken: 'secret-one-token',
    appSecret: 'shared-app-secret',
    verifyToken: 'verify-one',
  });
  const second = registry.put('instagram', {
    ownerId: two.id,
    accountId: '17841422222222222',
    username: 'client_two',
    accessToken: 'secret-two-token',
    appSecret: 'shared-app-secret',
    verifyToken: 'verify-two',
  });
  const extra = registry.put('instagram', {
    ownerId: one.id,
    accountId: '17841433333333333',
    username: 'client_one_extra',
    accessToken: 'extra-token',
    appSecret: 'different-app-secret',
    verifyToken: 'verify-extra',
  });
  const server = makeServer({ store, registry, automation: ig, facebookAutomation: fb });
  const a = store.login(one.email, 'customer-one-password', 'test'),
    b = store.login(two.email, 'customer-two-password', 'test');
  const headers = (session) => ({
    cookie: '__Host-conversa=' + session.token,
    origin: 'https://cc.chatgo.ia.bo',
    'content-type': 'application/json',
  });
  const get = (url, session = a) => http(server, 'GET', url, '', headers(session));
  const entry = (config, id = '18111111111111111', media = '17911111111111111') => ({
    id: config.accountId,
    time: Math.floor(now / 1000),
    changes: [
      {
        field: 'comments',
        value: { id, from: { id: '555555555555' }, media: { id: media }, text: 'Información' },
      },
    ],
  });
  try {
    await t.test(
      'Dos clientes ven solo sus cuentas y un cliente puede tener varias de Instagram',
      async () => {
        assert.equal((await get('/api/channel-accounts')).body.accounts.length, 2);
        assert.equal((await get('/api/channel-accounts', b)).body.accounts.length, 1);
        assert.equal((await get('/api/channel-accounts/' + second.id)).status, 404);
        assert.equal(
          (await get('/api/channel-accounts/' + first.id + '/automation', b)).status,
          404,
        );
        assert.equal((await get('/api/integrations/instagram')).status, 409);
        assert.equal((await http(server, 'GET', '/api/channel-accounts')).status, 401);
      },
    );
    await t.test(
      'La misma cuenta no se transfiere entre clientes y el cifrado autentica el negocio',
      () => {
        assert.throws(
          () => registry.put('instagram', { ...first, ownerId: two.id }),
          /otro negocio/,
        );
        assert.throws(
          () => registry.put('instagram', { ...first, username: 'stale' }, { expectedVersion: 0 }),
          /cambió/,
        );
        const raw = store.database
          .prepare('SELECT encrypted_config FROM channel_accounts WHERE id=?')
          .get(first.id).encrypted_config;
        assert.ok(!raw.includes('secret-one-token'));
        assert.ok(!readFileSync(path).includes(Buffer.from('secret-one-token')));
        const bad = openChannelAccounts(path, { key: randomBytes(32) });
        try {
          assert.throws(() => bad.get(first.id), /descifrar/);
        } finally {
          bad.close();
        }
        assert.equal(registry.get(first.id).accessToken, 'secret-one-token');
      },
    );
    await t.test(
      'No se exponen tokens ni secretos en metadatos y las reglas están acotadas a la cuenta elegida',
      async () => {
        const input = {
          mediaId: '17911111111111111',
          publicText: 'Te mandé información.',
          dmText: 'Mensaje privado',
          enabled: true,
          expectedVersion: null,
        };
        assert.equal(
          (
            await http(
              server,
              'PUT',
              '/api/channel-accounts/' + first.id + '/automation',
              input,
              headers(b),
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await http(
              server,
              'PUT',
              '/api/channel-accounts/' + first.id + '/automation',
              input,
              headers(a),
            )
          ).status,
          200,
        );
        ig.enable(second, input.mediaId, 'Public two', 'DM two');
        ig.enable(extra, input.mediaId, 'Public extra', 'DM extra');
        now += 1000;
        const payload = JSON.stringify({
          object: 'instagram',
          entry: [entry(first), entry(second), entry(extra)],
        });
        assert.equal(
          (
            await http(server, 'POST', '/api/webhooks/instagram', payload, {
              'x-hub-signature-256':
                'sha256=' + createHmac('sha256', 'shared-app-secret').update(payload).digest('hex'),
            })
          ).status,
          200,
        );
        assert.equal(ig.panelReport(one.id, first.accountId).summary.total, 1);
        assert.equal(ig.panelReport(two.id, second.accountId).summary.total, 1);
        assert.equal(ig.panelReport(one.id, extra.accountId).summary.total, 0);
        const catalog = JSON.stringify((await get('/api/channel-accounts')).body);
        for (const secret of [
          'secret-one-token',
          'secret-two-token',
          'shared-app-secret',
          'different-app-secret',
        ])
          assert.ok(!catalog.includes(secret));
      },
    );
    await t.test(
      'Los eventos del mismo cliente se filtran por cuenta antes del límite y no cruzan clientes',
      async () => {
        const events = await get('/api/channel-accounts/' + first.id + '/events');
        assert.equal(events.body.events.length, 1);
        assert.equal(events.body.events[0].entry.id, first.accountId);
        assert.equal(
          (await get('/api/channel-accounts/' + extra.id + '/events')).body.events.length,
          0,
        );
        assert.equal((await get('/api/channel-accounts/' + first.id + '/events', b)).status, 404);
      },
    );
    await t.test(
      'Workers avanzan varias cuentas sin mezclar tokens ni bloquear a los otros clientes',
      async () => {
        const calls = [];
        const worker = createInstagramWorker({
          automation: ig,
          instagram: () => registry.all('instagram'),
          request: async (url, options) => {
            calls.push({
              url,
              token: options.headers.Authorization,
              body: JSON.parse(options.body),
            });
            return ok(
              url.endsWith('/replies') ? { id: 'public-id' } : { message_id: 'private-id' },
            );
          },
        });
        await worker.tick();
        await worker.tick();
        assert.equal(calls.length, 4);
        assert.ok(calls.some((c) => c.token === 'Bearer secret-one-token'));
        assert.ok(calls.some((c) => c.token === 'Bearer secret-two-token'));
        assert.equal(ig.panelReport(one.id, first.accountId).actions[0].status, 'sent');
        assert.equal(ig.panelReport(two.id, second.accountId).actions[0].status, 'sent');
        assert.equal((await get('/api/notifications')).body.unread, 1);
        assert.equal((await get('/api/notifications', b)).body.unread, 1);
        await worker.stop();
      },
    );
    await t.test(
      'Solo el administrador crea clientes y el nuevo acceso empieza sin datos ajenos',
      async () => {
        const data = {
          name: 'Tercer negocio',
          email: 'three@example.test',
        };
        assert.equal(
          (await http(server, 'POST', '/api/admin/customers', data, headers(b))).status,
          403,
        );
        registry.grantAdmin(one.id);
        const created = await http(server, 'POST', '/api/admin/customers', data, headers(a));
        assert.equal(created.status, 201);
        assert.equal(created.body.business.name, data.name);
        assert.equal(
          (await http(server, 'POST', '/api/admin/customers', data, headers(a))).status,
          422,
        );
        assert.equal(store.login(data.email, 'third-customer-password', 'test'), null);
        const invitation = created.body.invitation.url.split('#')[1];
        assert.equal(
          (
            await http(
              server,
              'POST',
              '/api/invitations/accept',
              { token: invitation, password: 'third-customer-password' },
              headers(a),
            )
          ).status,
          200,
        );
        const c = store.login(data.email, 'third-customer-password', 'test');
        assert.equal((await get('/api/channel-accounts', c)).body.accounts.length, 0);
        assert.equal((await get('/api/admin/customers', c)).status, 403);
      },
    );
    await t.test('Un atacante desde otra IP no bloquea el acceso correcto del propietario', () => {
      for (let n = 0; n < 11; n++) store.login(one.email, 'wrong', 'attacker-ip');
      assert.ok(store.login(one.email, 'customer-one-password', 'owner-ip')?.token);
    });
  } finally {
    ig.close();
    fb.close();
    registry.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Migración existente: conserva tokens, reglas, usuarios y actividad; no reimporta ni pierde la llave', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-migration-')),
    path = join(dir, 'test.sqlite'),
    keyPath = join(dir, 'keys/master.key');
  let store = openStore(path);
  store.setPassword('old@example.test', 'migration-password', true);
  const owner = store.userByEmail('old@example.test');
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE instagram_rules(account_id TEXT,media_id TEXT,user_id TEXT,public_text TEXT,dm_text TEXT,enabled INTEGER,enabled_at INTEGER,PRIMARY KEY(account_id,media_id));
    CREATE TABLE instagram_actions(account_id TEXT,comment_id TEXT,user_id TEXT,media_id TEXT,rule_enabled_at INTEGER,comment_at INTEGER,public_text TEXT,dm_text TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,public_id TEXT,message_id TEXT,last_error TEXT,PRIMARY KEY(account_id,comment_id));`);
  const config = {
    ownerId: owner.id,
    ownerEmail: owner.email,
    accountId: '17841499999999999',
    username: 'old_account',
    accessToken: 'old-private-token',
    appSecret: 'a'.repeat(32),
    verifyToken: 'old-verifier',
    checkedAt: new Date().toISOString(),
  };
  raw
    .prepare('INSERT INTO instagram_rules VALUES (?,?,?,?,?,1,?)')
    .run(
      config.accountId,
      '17999999999999999',
      owner.id,
      'Old public',
      'Old DM',
      Date.now() - 5000,
    );
  raw
    .prepare('INSERT INTO instagram_actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      config.accountId,
      '18199999999999999',
      owner.id,
      '17999999999999999',
      Date.now() - 5000,
      Date.now() - 1000,
      'Old public',
      'Old DM',
      'sent',
      Date.now(),
      Date.now(),
      'old-public',
      'old-dm',
      null,
    );
  raw.close();
  writeFileSync(join(dir, 'instagram.credentials.json'), JSON.stringify(config), { mode: 0o600 });
  try {
    await initialize({ database: path, keyPath, instagramAppId: '1797199674816532', uid: null });
    assert.equal(existsSync(join(dir, 'instagram.credentials.json')), false);
    store = openStore(path);
    const registry = openChannelAccounts(path, { keyPath });
    const ig = openInstagramAutomation(path);
    const migrated = registry.lookup('instagram', config.accountId);
    assert.equal(migrated.accessToken, config.accessToken);
    assert.equal(migrated.verifyToken, config.verifyToken);
    assert.equal(registry.isAdmin(owner.id), true);
    assert.equal(ig.report(owner.id).actions[0].message_id, 'old-dm');
    assert.equal(ig.report(owner.id).rules[0].public_text, 'Old public');
    assert.equal(
      store.notificationFeed(owner.id, [{ channel: 'instagram', accountId: config.accountId }])
        .unread,
      0,
    );
    const changed = registry.put(
      'instagram',
      { ...migrated, accessToken: 'renewed-private-token' },
      { expectedVersion: migrated.version },
    );
    writeFileSync(join(dir, 'instagram.credentials.json'), JSON.stringify(config));
    registry.migrateLegacy(dir, { remove: true });
    assert.equal(registry.get(changed.id).accessToken, 'renewed-private-token');
    ig.close();
    registry.close();
    store.close();
    store = null;
    const originalKey = readFileSync(keyPath);
    await initialize({ database: path, keyPath, uid: null });
    assert.deepEqual(readFileSync(keyPath), originalKey);
    rmSync(keyPath);
    await assert.rejects(initialize({ database: path, keyPath, uid: null }), /llave original/);
    assert.equal(existsSync(keyPath), false);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Renovación de Instagram comprueba identidad y duración sin imprimir credenciales', async () => {
  const now = () => 1800000000000,
    config = { accountId: '17841499999999999', accessToken: 'old-token', username: 'old' };
  let calls = 0;
  const refreshed = await refreshInstagramCredential(
    config,
    async (url, options) => {
      calls++;
      if (url.includes('refresh_access_token'))
        return ok({ access_token: 'new-long-token', expires_in: 5184000 });
      assert.equal(options.headers.Authorization, 'Bearer new-long-token');
      return ok({ user_id: config.accountId, username: 'renewed' });
    },
    now,
  );
  assert.equal(calls, 2);
  assert.equal(refreshed.tokenInfo.expiresAt, Math.floor(now() / 1000) + 5184000);
  assert.equal(refreshed.accessToken, 'new-long-token');
  assert.ok(refreshed.nextRefreshAt > now() + 86400_000);
  await assert.rejects(
    refreshInstagramCredential(
      config,
      async () => ok({ access_token: 'short', expires_in: 3600 }),
      now,
    ),
    /larga duración/,
  );
  let n = 0;
  await assert.rejects(
    refreshInstagramCredential(
      config,
      async () =>
        ++n === 1
          ? ok({ access_token: 'long', expires_in: 5184000 })
          : ok({ user_id: '11111111111', username: 'other' }),
      now,
    ),
    /otra cuenta/,
  );
});

test('Restauración offline verifica la llave y recupera la base y credenciales anteriores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-restore-')),
    database = join(dir, 'test.sqlite'),
    keyPath = join(dir, 'keys/master.key');
  const s = openStore(database);
  s.setPassword('restore@example.test', 'restore-fixture-password', true);
  const owner = s.userByEmail('restore@example.test');
  s.close();
  const credentials = {
    ownerId: owner.id,
    ownerEmail: owner.email,
    accountId: '17841488888888888',
    username: 'restore_fixture',
    accessToken: 'private-fixture-token',
    appSecret: 'a'.repeat(32),
    verifyToken: 'restore-fixture-verifier',
  };
  const legacy = join(dir, 'instagram.credentials.json');
  writeFileSync(legacy, JSON.stringify(credentials), { mode: 0o600 });
  try {
    await initialize({ database, keyPath, instagramAppId: '1797199674816532', uid: null });
    const backupName = readdirSync(join(dir, 'migration-backups')).find((v) =>
      /^before-multiclient-\d+\.sqlite$/.test(v),
    );
    const originalKey = readFileSync(keyPath);
    writeFileSync(keyPath, randomBytes(32));
    await assert.rejects(
      restoreMigration({ database, keyPath, backupName, uid: null }),
      /descifrar/,
    );
    assert.equal(existsSync(legacy), false);
    writeFileSync(keyPath, originalKey);
    await restoreMigration({ database, keyPath, backupName, uid: null });
    assert.deepEqual(JSON.parse(readFileSync(legacy)), credentials);
    const raw = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(
        raw.prepare("SELECT 1 FROM sqlite_master WHERE name='channel_accounts'").get(),
        undefined,
      );
    } finally {
      raw.close();
    }
    assert.ok(
      readdirSync(join(dir, 'migration-backups')).some((v) => v.startsWith('before-restore-')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
