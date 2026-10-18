import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadMasterKey, unseal } from './channel-accounts.mjs';

const secretPattern =
  /^projects\/([a-z][a-z0-9-]{4,62}|\d+)\/secrets\/([a-zA-Z0-9_-]{1,255})\/versions\/([1-9]\d*)$/;
const sha = (data) => createHash('sha256').update(data).digest('hex');
async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function readManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (
    manifest.version !== 1 ||
    !secretPattern.test(manifest.keySecretVersion || '') ||
    !/^[a-f0-9]{64}$/.test(manifest.databaseSha256 || '') ||
    !/^[a-f0-9]{64}$/.test(manifest.keySha256 || '') ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  )
    throw new Error('Manifiesto no válido.');
  return manifest;
}
export async function createBackup({
  database,
  keyPath,
  destination,
  secretVersion,
  expectedKeySha,
}) {
  if (!secretPattern.test(secretVersion || ''))
    throw new Error('Indica una versión numérica de Secret Manager, nunca latest.');
  const key = loadMasterKey(keyPath);
  if (!/^[a-f0-9]{64}$/.test(expectedKeySha || '') || sha(key) !== expectedKeySha)
    throw new Error('La llave local no coincide con la versión de recuperación registrada.');
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const snapshot = join(destination, 'database.sqlite');
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(source, snapshot);
    chmodSync(snapshot, 0o600);
  } finally {
    source.close();
  }
  // A restored standalone snapshot must not depend on live WAL/SHM files.
  const portable = new DatabaseSync(snapshot);
  try {
    portable.exec('PRAGMA journal_mode=DELETE');
  } finally {
    portable.close();
  }
  verifyDatabase(snapshot, key);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    keySecretVersion: secretVersion,
    keySha256: expectedKeySha,
    databaseSha256: await checksum(snapshot),
  };
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest), {
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}
export async function verifyRestore(directory) {
  const manifest = readManifest(join(directory, 'manifest.json'));
  const key = loadMasterKey(join(directory, 'master.key'));
  if (sha(key) !== manifest.keySha256)
    throw new Error('La llave recuperada no corresponde al respaldo.');
  const snapshot = join(directory, 'database.sqlite');
  if ((await checksum(snapshot)) !== manifest.databaseSha256)
    throw new Error('El respaldo no coincide con su checksum.');
  return { ...verifyDatabase(snapshot, key), createdAt: manifest.createdAt };
}
function verifyDatabase(snapshot, key) {
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try {
    if (
      db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('El respaldo no pasó la comprobación de integridad.');
    const accounts = db.prepare('SELECT * FROM channel_accounts').all();
    for (const row of accounts)
      unseal(
        row.encrypted_config,
        key,
        `account:${row.id}:${row.business_id}:${row.owner_id}:${row.channel}:${row.account_id}`,
      );
    const apps = db.prepare('SELECT * FROM provider_apps').all();
    for (const row of apps) unseal(row.encrypted_config, key, `app:${row.channel}:${row.app_id}`);
    const selections = db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='oauth_selections'")
      .get();
    if (selections)
      for (const row of db.prepare('SELECT * FROM oauth_selections').all())
        unseal(row.encrypted_data, key, `selection:${row.id}:${row.user_id}`);
    return {
      verified: true,
      accounts: accounts.length,
      applications: apps.length,
    };
  } finally {
    db.close();
  }
}
function updateStatus(database, success, id) {
  const path = join(dirname(database), 'offsite-status.json');
  let prior = {};
  try {
    prior = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* First attempt. */
  }
  const now = new Date().toISOString();
  const value = {
    lastAttempt: now,
    lastSuccess: success ? now : prior.lastSuccess || null,
    backupId: success ? id : prior.backupId || null,
    error: success ? null : 'El respaldo externo falló. Revisa el servicio programado.',
  };
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export function readBackupStatus(database) {
  try {
    const status = JSON.parse(readFileSync(join(dirname(database), 'offsite-status.json'), 'utf8'));
    const lastSuccess = typeof status.lastSuccess === 'string' ? status.lastSuccess : null;
    const recent =
      lastSuccess &&
      Date.now() - Date.parse(lastSuccess) >= 0 &&
      Date.now() - Date.parse(lastSuccess) < 36 * 3600_000;
    return {
      configured: !!recent && !status.error,
      lastSuccess,
      error: typeof status.error === 'string' ? status.error : null,
    };
  } catch {
    return { configured: false, lastSuccess: null, error: null };
  }
}
if (process.argv[1]?.endsWith('/offsite-backup.mjs')) {
  const [command, arg] = process.argv.slice(2);
  const database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
  const validId = /^[a-z0-9-]{10,90}$/.test(arg || '');
  const parent = join(dirname(database), 'offsite-pending');
  try {
    if (command === 'create' && validId) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      await createBackup({
        database,
        keyPath: process.env.MASTER_KEY_PATH || '/run/conversa-keys/master.key',
        destination: join(parent, arg),
        secretVersion: process.env.CONVERSA_KEY_SECRET_VERSION,
        expectedKeySha: process.env.CONVERSA_MASTER_KEY_SHA256,
      });
    } else if (command === 'remove' && validId)
      rmSync(join(parent, arg), { recursive: true, force: true });
    else if (['success', 'failure'].includes(command) && validId)
      updateStatus(database, command === 'success', arg);
    else if (command === 'verify') console.log(JSON.stringify(await verifyRestore(arg)));
    else if (command === 'secret-ref') {
      const [, project, secret, version] = secretPattern.exec(readManifest(arg).keySecretVersion);
      console.log([project, secret, version].join(' '));
    } else throw new Error('Operación no válida.');
  } catch {
    console.error(
      'No se pudo completar la operación de respaldo. Verifica configuración, llave e integridad; no se expusieron credenciales.',
    );
    process.exitCode = 1;
  }
}
