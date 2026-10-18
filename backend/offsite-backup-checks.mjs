import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { openStore } from './store.mjs';
import { openChannelAccounts, createMasterKey } from './channel-accounts.mjs';
import { createBackup, verifyRestore, readBackupStatus } from './offsite-backup.mjs';
import { DatabaseSync } from 'node:sqlite';

test('Respaldo separado: copia SQLite coherente, llave externa, integridad y descifrado real', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-offsite-')),
    database = join(dir, 'live.sqlite'),
    keyPath = join(dir, 'private/master.key');
  const key = createMasterKey(keyPath),
    fingerprint = createHash('sha256').update(key).digest('hex');
  const store = openStore(database),
    registry = openChannelAccounts(database, { key });
  store.setPassword('backup@example.test', 'backup-fixture-password', true);
  const owner = store.userByEmail('backup@example.test');
  registry.setApp('instagram', '1797199674816532', {
    appSecret: 'a'.repeat(32),
    verifyToken: 'fixture-verifier',
  });
  registry.put('instagram', {
    ownerId: owner.id,
    accountId: '17841411111111111',
    username: 'backup_fixture',
    accessToken: 'private-fixture-token',
    appSecret: 'a'.repeat(32),
  });
  const destination = join(dir, 'external-copy');
  const options = {
    database,
    keyPath,
    destination,
    secretVersion: 'projects/conversa-app-511802/secrets/conversa-master-key/versions/1',
    expectedKeySha: fingerprint,
  };
  try {
    await t.test('No acepta latest ni una huella sin correspondencia', async () => {
      await assert.rejects(
        createBackup({ ...options, secretVersion: options.secretVersion.replace('/1', '/latest') }),
        /numérica/,
      );
      await assert.rejects(
        createBackup({ ...options, expectedKeySha: '0'.repeat(64) }),
        /no coincide/,
      );
    });
    await createBackup(options);
    await t.test('La copia externa no contiene la llave; el token tampoco queda en claro', () => {
      assert.deepEqual(readdirSync(destination).sort(), ['database.sqlite', 'manifest.json']);
      assert.ok(
        !readFileSync(join(destination, 'database.sqlite')).includes(
          Buffer.from('private-fixture-token'),
        ),
      );
      assert.ok(!readFileSync(join(destination, 'manifest.json')).includes(key));
    });
    await t.test(
      'El estado live posterior no altera la copia y ambas conexiones pueden seguir abiertas',
      async () => {
        store.setPassword('later@example.test', 'later-fixture-password', true);
        const copy = new DatabaseSync(join(destination, 'database.sqlite'), { readOnly: true });
        try {
          assert.equal(copy.prepare('SELECT count(*) AS n FROM users').get().n, 1);
        } finally {
          copy.close();
        }
        copyFileSync(keyPath, join(destination, 'master.key'));
        const result = await verifyRestore(destination);
        assert.deepEqual(
          {
            verified: result.verified,
            accounts: result.accounts,
            applications: result.applications,
          },
          { verified: true, accounts: 1, applications: 1 },
        );
      },
    );
    await t.test(
      'Una llave equivocada o un byte alterado no se aceptan como restauración',
      async () => {
        writeFileSync(join(destination, 'master.key'), randomBytes(32));
        await assert.rejects(verifyRestore(destination), /llave recuperada/);
        copyFileSync(keyPath, join(destination, 'master.key'));
        const original = readFileSync(join(destination, 'database.sqlite'));
        const changed = Buffer.from(original);
        changed[100] ^= 1;
        writeFileSync(join(destination, 'database.sqlite'), changed);
        await assert.rejects(verifyRestore(destination), /checksum/);
        writeFileSync(join(destination, 'database.sqlite'), original);
        assert.equal((await verifyRestore(destination)).verified, true);
      },
    );
    await t.test('Sin éxito externo reciente no se declara el respaldo configurado', () => {
      assert.equal(readBackupStatus(database).configured, false);
      writeFileSync(
        join(dir, 'offsite-status.json'),
        JSON.stringify({ lastSuccess: new Date().toISOString(), error: null }),
      );
      assert.equal(readBackupStatus(database).configured, true);
      writeFileSync(
        join(dir, 'offsite-status.json'),
        JSON.stringify({ lastSuccess: new Date().toISOString(), error: 'falló' }),
      );
      assert.equal(readBackupStatus(database).configured, false);
    });
  } finally {
    registry.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
