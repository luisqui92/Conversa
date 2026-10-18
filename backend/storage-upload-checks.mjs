import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { uploadBackup } from './storage-upload.mjs';

test('La copia usa solo inserciones con precondición, sin lectura del bucket ni credenciales impresas', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'conversa-upload-')),
    backupId = '20261018t140628z-fixture',
    bucket = 'fixture-backups';
  const database = Buffer.from('fixture database without keys'),
    token = 'fixture-metadata-token';
  writeFileSync(join(directory, 'database.sqlite'), database, { mode: 0o600 });
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      databaseSha256: createHash('sha256').update(database).digest('hex'),
      keySha256: 'a'.repeat(64),
      keySecretVersion: 'projects/conversa-app-511802/secrets/conversa-master-key/versions/1',
    }),
    { mode: 0o600 },
  );
  let mode = 'success',
    calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    calls.push({ method: req.method, path: url.pathname, name: url.searchParams.get('name') });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/metadata') {
      assert.equal(req.headers['metadata-flavor'], 'Google');
      res.setHeader('Metadata-Flavor', 'Google');
      res.statusCode = mode === 'metadata-failure' ? 403 : 200;
      return res.end(JSON.stringify({ access_token: token }));
    }
    // The simulated storage identity cannot read, list, inspect or overwrite any object.
    if (req.method !== 'POST' || url.searchParams.get('ifGenerationMatch') !== '0') {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'No object read permission' }));
    }
    assert.equal(url.searchParams.get('uploadType'), 'media');
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    const body = [];
    for await (const part of req) body.push(part);
    const data = Buffer.concat(body),
      name = url.searchParams.get('name');
    assert.equal(String(data.length), req.headers['content-length']);
    if (name.endsWith('database.sqlite')) assert.deepEqual(data, database);
    else assert.ok(!data.includes(Buffer.from(token)));
    if (
      mode === 'database-failure' ||
      (mode === 'manifest-failure' && name.endsWith('manifest.json'))
    ) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: token }));
    }
    if (mode === 'collision') {
      res.statusCode = 412;
      return res.end('{}');
    }
    return res.end(
      JSON.stringify({
        name,
        generation: '1',
        size: mode === 'wrong-confirmation' ? '999999' : String(data.length),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const request = (url, options) => {
    const u = new URL(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (u.hostname === 'metadata.google.internal') return fetch(endpoint + '/metadata', options);
    assert.equal(u.origin, 'https://storage.googleapis.com');
    return fetch(endpoint + u.pathname + u.search, options);
  };
  const upload = () => uploadBackup({ directory, backupId, bucket, request });
  try {
    await t.test(
      'La subida real por streaming publica SQLite primero y el manifiesto al final',
      async () => {
        assert.deepEqual(await upload(), { uploaded: true, backupId });
        assert.deepEqual(
          calls.map((c) => c.method),
          ['GET', 'POST', 'POST'],
        );
        assert.deepEqual(
          calls.slice(1).map((c) => c.name),
          [`conversa/${backupId}/database.sqlite`, `conversa/${backupId}/manifest.json`],
        );
      },
    );
    for (const errorMode of [
      'metadata-failure',
      'database-failure',
      'manifest-failure',
      'collision',
      'wrong-confirmation',
    ]) {
      await t.test(
        'No declara éxito ni hace lecturas o sobrescrituras cuando falla ' + errorMode,
        async () => {
          mode = errorMode;
          calls = [];
          await assert.rejects(upload(), (error) => !error.message.includes(token));
          assert.ok(calls.slice(1).every((c) => c.method === 'POST'));
          assert.equal(
            calls.length,
            errorMode === 'metadata-failure' ? 1 : errorMode === 'manifest-failure' ? 3 : 2,
          );
        },
      );
    }
    await t.test(
      'Datos alterados y destinos inválidos se rechazan antes de pedir autorización',
      async () => {
        calls = [];
        writeFileSync(join(directory, 'database.sqlite'), 'changed');
        await assert.rejects(upload(), /cambió/);
        await assert.rejects(
          uploadBackup({ directory, bucket: 'https://invalid', backupId, request }),
          /no válido/,
        );
        await assert.rejects(
          uploadBackup({ directory, bucket, backupId: '../../secret', request }),
          /no válido/,
        );
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
