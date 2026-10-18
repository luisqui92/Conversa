import { DatabaseSync, backup } from 'node:sqlite';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  chownSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { openStore } from './store.mjs';
import {
  openChannelAccounts,
  createMasterKey,
  loadMasterKey,
  seal,
  unseal,
} from './channel-accounts.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';

export async function initialize({
  database = process.env.DATABASE_PATH || '/data/conversa.sqlite',
  keyPath = process.env.MASTER_KEY_PATH || '/run/conversa-keys/master.key',
  instagramAppId = process.env.INSTAGRAM_APP_ID,
  uid = process.getuid?.() === 0 ? 1000 : null,
} = {}) {
  const directory = dirname(database),
    backups = join(directory, 'migration-backups');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const backupName = 'before-multiclient-' + Date.now() + '.sqlite',
    backupPath = join(backups, backupName);
  let hadDatabase = existsSync(database),
    key,
    store,
    registry,
    automation;
  const originals = [];
  for (const channel of ['instagram', 'facebook']) {
    const path = join(directory, channel + '.credentials.json');
    if (existsSync(path)) originals.push({ channel, content: readFileSync(path, 'utf8') });
  }
  if (hadDatabase) {
    const source = new DatabaseSync(database, { readOnly: true });
    try {
      const encrypted = source
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_accounts'")
        .get();
      if (
        encrypted &&
        (source.prepare('SELECT 1 FROM channel_accounts LIMIT 1').get() ||
          source.prepare('SELECT 1 FROM provider_apps LIMIT 1').get()) &&
        !existsSync(keyPath)
      )
        throw new Error(
          'La base contiene credenciales cifradas pero falta su llave. Restaura la llave original; no se generará otra.',
        );
      await backup(source, backupPath);
      chmodSync(backupPath, 0o600);
    } finally {
      source.close();
    }
  }
  key = createMasterKey(keyPath);
  const recoveryPath = join(backups, backupName + '.recovery.enc');
  writeFileSync(recoveryPath, seal({ backupName, originals }, key, 'migration:' + backupName), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    store = openStore(database);
    registry = openChannelAccounts(database, { key });
    for (const user of store.database.prepare('SELECT id FROM users').all())
      registry.business(user.id);
    const imported = registry.migrateLegacy(directory, { instagramAppId, remove: false });
    automation = openInstagramAutomation(database); // Migrates both channels in one transaction.
    for (const row of store.database.prepare('SELECT id FROM channel_accounts').all())
      registry.get(row.id);
    for (const channel of ['instagram', 'facebook']) registry.app(channel);
    automation.close();
    automation = null;
    registry.close();
    registry = null;
    store.close();
    store = null;
    for (const original of originals)
      unlinkSync(join(directory, original.channel + '.credentials.json'));
    if (uid !== null) {
      for (const path of [
        directory,
        backups,
        dirname(keyPath),
        database,
        keyPath,
        backupPath,
        recoveryPath,
        database + '-wal',
        database + '-shm',
      ])
        if (existsSync(path)) chownSync(path, uid, uid);
    }
    writeFileSync(join(backups, 'last-migration.json'), JSON.stringify({ backupName }), {
      mode: 0o600,
    });
    if (uid !== null) chownSync(join(backups, 'last-migration.json'), uid, uid);
    console.log(
      `Inicialización completada. Conexiones importadas: ${imported.length}. Credenciales cifradas; respaldo previo conservado.`,
    );
  } catch (error) {
    automation?.close();
    registry?.close();
    store?.close();
    if (hadDatabase) {
      for (const suffix of ['-wal', '-shm'])
        try {
          unlinkSync(database + suffix);
        } catch {}
      const temp = database + '.restore';
      writeFileSync(temp, readFileSync(backupPath), { mode: 0o600 });
      renameSync(temp, database);
      if (uid !== null) chownSync(database, uid, uid);
    }
    for (const original of originals) {
      const path = join(directory, original.channel + '.credentials.json');
      if (!existsSync(path)) writeFileSync(path, original.content, { flag: 'wx', mode: 0o600 });
      if (uid !== null) chownSync(path, uid, uid);
    }
    throw new Error(
      'La migración no se completó. Se restauraron la base y las conexiones anteriores. ' +
        (error.message.startsWith('La base contiene')
          ? error.message
          : 'Revisa la configuración antes de volver a intentar.'),
    );
  }
}
if (process.argv[1]?.endsWith('/initialize.mjs'))
  initialize().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
