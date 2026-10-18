import { createReadStream, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readManifest } from './offsite-backup.mjs';

const metadataToken =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function uploadBackup({ directory, bucket, backupId, request = fetch }) {
  if (
    !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket || '') ||
    !/^[a-z0-9-]{10,90}$/.test(backupId || '')
  )
    throw new Error('Destino de respaldo no válido.');
  const files = ['database.sqlite', 'manifest.json'].map((name) => {
    const path = join(directory, name),
      stat = lstatSync(path);
    if (!stat.isFile() || !stat.size) throw new Error('Archivo de respaldo no válido.');
    return { name, path, size: stat.size };
  });
  const manifest = readManifest(files[1].path);
  if ((await checksum(files[0].path)) !== manifest.databaseSha256)
    throw new Error('El respaldo cambió antes de subirlo.');
  let token;
  try {
    const response = await request(metadataToken, {
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google') throw new Error();
    const data = await response.json();
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      data.access_token.length > 16384 ||
      /\s/.test(data.access_token)
    )
      throw new Error();
    token = data.access_token;
  } catch {
    throw new Error('No se pudo obtener la autorización de la cuenta de servicio de la VM.');
  }
  for (const file of files) {
    const name = `conversa/${backupId}/${file.name}`;
    const url = new URL(
      'https://storage.googleapis.com/upload/storage/v1/b/' + encodeURIComponent(bucket) + '/o',
    );
    url.search = new URLSearchParams({
      uploadType: 'media',
      name,
      ifGenerationMatch: '0',
    }).toString();
    const stream = createReadStream(file.path);
    let responseStatus;
    try {
      // POST inserts need object creation only. Never probe with GET, HEAD, list or overwrite.
      const response = await request(url.href, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        duplex: 'half',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': file.name.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
          'Content-Length': String(file.size),
        },
        body: stream,
      });
      responseStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const created = await response.json();
      if (
        created.name !== name ||
        !/^[1-9]\d*$/.test(created.generation || '') ||
        created.size !== String(file.size)
      )
        throw new Error();
    } catch {
      // Provider bodies, request URLs, tokens and raw fetch errors are never logged.
      throw new Error(
        'Storage no confirmó la creación de ' +
          file.name +
          (responseStatus ? ` (HTTP ${responseStatus})` : '') +
          '. Se conserva el permiso de solo creación.',
      );
    } finally {
      stream.destroy();
    }
  }
  return { uploaded: true, backupId };
}
if (process.argv[1]?.endsWith('/storage-upload.mjs')) {
  const id = process.argv[2],
    database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
  if (!/^[a-z0-9-]{10,90}$/.test(id || '')) {
    console.error('Identificador de respaldo no válido.');
    process.exitCode = 1;
  } else {
    try {
      await uploadBackup({
        directory: join(dirname(database), 'offsite-pending', id),
        bucket: process.env.CONVERSA_BACKUP_BUCKET,
        backupId: id,
      });
    } catch (error) {
      console.error(
        error.message.startsWith('Storage no confirmó') ||
          error.message.startsWith('No se pudo obtener')
          ? error.message
          : 'No se pudo subir el respaldo. Revisa sus archivos y configuración.',
      );
      process.exitCode = 1;
    }
  }
}
