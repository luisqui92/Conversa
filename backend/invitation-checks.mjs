import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from './store.mjs';
import { openChannelAccounts } from './channel-accounts.mjs';
import { createInvitations } from './invitations.mjs';

test('Invitaciones: contraseña privada, token de un uso, caducidad y renovación limitada', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-invite-')),
    path = join(dir, 'test.sqlite');
  let now = Date.now();
  const store = openStore(path, { now: () => now }),
    registry = openChannelAccounts(path, { key: randomBytes(32) });
  store.setPassword('admin@example.test', 'admin-fixture-password', true);
  const admin = store.userByEmail('admin@example.test');
  registry.grantAdmin(admin.id);
  const invites = createInvitations({
    store,
    registry,
    origin: 'https://cc.chatgo.ia.bo',
    now: () => now,
  });
  const created = invites.create(
    { name: 'Cliente privado', email: 'client@example.test' },
    admin.id,
  );
  const token = created.invitation.url.split('#')[1];
  try {
    await t.test(
      'El administrador no recibe ni decide una contraseña y el token se guarda solo como hash',
      () => {
        assert.ok(/^[a-f0-9]{64}$/.test(token));
        assert.equal(created.invitation.url.split('?').length, 1);
        assert.equal(store.login('client@example.test', 'client-fixture-password', 'one'), null);
        assert.deepEqual(invites.inspect(token), {
          email: 'client@example.test',
          business: 'Cliente privado',
          expiresAt: now + 86400_000,
        });
        assert.ok(
          !store.database
            .prepare('SELECT token_hash FROM customer_invitations')
            .get()
            .token_hash.includes(token),
        );
        assert.ok(!readFileSync(path).includes(Buffer.from(token)));
        assert.throws(
          () =>
            invites.create(
              { name: 'Otro', email: 'other@example.test', password: 'admin-knows-this' },
              admin.id,
            ),
          /cliente elegirá/,
        );
      },
    );
    await t.test(
      'Crear y reemitir requiere administrador, renovar invalida el enlace anterior',
      () => {
        assert.throws(
          () => invites.create({ name: 'Otro', email: 'other@example.test' }, created.user.id),
          /administrador/,
        );
        assert.throws(() => invites.reissue(created.user.id, created.user.id), /administrador/);
        const next = invites.reissue(created.user.id, admin.id).invitation.url.split('#')[1];
        assert.throws(() => invites.inspect(token), /inválida/);
        assert.ok(invites.inspect(next));
      },
    );
    await t.test(
      'Caducidad y contraseñas inválidas no cambian el acceso ni consumen una invitación vigente',
      () => {
        const next = invites.reissue(created.user.id, admin.id).invitation.url.split('#')[1];
        assert.throws(() => invites.accept(next, 'short'), /12 a 256/);
        assert.ok(invites.inspect(next));
        now += 86400_001;
        assert.throws(() => invites.accept(next, 'client-fixture-password'), /vencida/);
        assert.equal(store.login('client@example.test', 'client-fixture-password', 'one'), null);
      },
    );
    await t.test(
      'El cliente establece su contraseña una vez; ni replay ni reemisión alteran un acceso activado',
      () => {
        const next = invites.reissue(created.user.id, admin.id).invitation.url.split('#')[1];
        assert.deepEqual(invites.accept(next, 'client-fixture-password'), { activated: true });
        assert.ok(store.login('client@example.test', 'client-fixture-password', 'one')?.token);
        assert.throws(() => invites.accept(next, 'attacker-replacement-password'), /inválida/);
        assert.throws(() => invites.reissue(created.user.id, admin.id), /pendiente/);
        assert.ok(store.login('client@example.test', 'client-fixture-password', 'two')?.token);
        assert.equal(
          invites.customers().find((c) => c.owner_id === created.user.id).invitationPending,
          false,
        );
      },
    );
    await t.test('La cuota de consulta de invitaciones no bloquea otra IP', () => {
      for (let i = 0; i < 60; i++) assert.equal(invites.allow('abusive-ip'), true);
      assert.equal(invites.allow('abusive-ip'), false);
      assert.equal(invites.allow('customer-ip'), true);
    });
  } finally {
    registry.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
