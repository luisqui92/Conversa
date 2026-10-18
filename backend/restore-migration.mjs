import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, chownSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadMasterKey, unseal } from './channel-accounts.mjs';

// Run only with the API stopped. The caller keeps the matching master key volume.
export async function restoreMigration({
  backupName,
  database = process.env.DATABASE_PATH || '/data/conversa.sqlite',
  keyPath = process.env.MASTER_KEY_PATH || '/run/conversa-keys/master.key',
  uid = process.getuid?.() === 0 ? 1000 : null,
}) {
  if (!/^before-multiclient-\d+\.sqlite$/.test(backupName || ''))
    throw new Error('Indica el nombre exacto de un respaldo de migración.');
  const directory = dirname(database),
    backups = join(directory, 'migration-backups');
  const source = join(backups, backupName);
  const recovery = unseal(
    readFileSync(source + '.recovery.enc', 'utf8'),
    loadMasterKey(keyPath),
    'migration:' + backupName,
  );
  if (
    recovery.backupName !== backupName ||
    !Array.isArray(recovery.originals) ||
    recovery.originals.some(
      (v) => !['instagram', 'facebook'].includes(v.channel) || typeof v.content !== 'string',
    )
  )
    throw new Error('El paquete de recuperación no es válido.');
  const check = new DatabaseSync(source, { readOnly: true });
  try {
    if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
      throw new Error('El respaldo no pasó la comprobación de integridad.');
  } finally {
    check.close();
  }
  const savedCurrent = join(backups, 'before-restore-' + Date.now() + '.sqlite');
  const current = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(current, savedCurrent);
    chmodSync(savedCurrent, 0o600);
  } finally {
    current.close();
  }
  const replace = (path, data) => {
    const temp = path + '.restore';
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
    if (uid !== null) chownSync(path, uid, uid);
  };
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(database + suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  replace(database, readFileSync(source));
  for (const original of recovery.originals)
    replace(join(directory, original.channel + '.credentials.json'), original.content);
  if (uid !== null) chownSync(savedCurrent, uid, uid);
  console.log(
    'Respaldo restaurado. La base anterior a esta restauración se conservó. Inicia únicamente el código compatible con el respaldo elegido.',
  );
}
if (process.argv[1]?.endsWith('/restore-migration.mjs')) {
  if (process.env.CONVERSA_RESTORE_OFFLINE !== '1') {
    console.error(
      'Detén la API y ejecuta desde el servicio de mantenimiento con CONVERSA_RESTORE_OFFLINE=1.',
    );
    process.exitCode = 1;
  } else
    restoreMigration({ backupName: process.argv[2] }).catch(() => {
      console.error(
        'No se pudo restaurar. Verifica el respaldo y su llave; conserva el servicio detenido para revisar.',
      );
      process.exitCode = 1;
    });
}
