import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openStore } from '../backend/store.mjs';
import { openChannelAccounts, createMasterKey } from '../backend/channel-accounts.mjs';
import { createBackup } from '../backend/offsite-backup.mjs';

test('Procedimiento de recuperación: almacenamiento simulado y verificación real sin red en Docker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-restore-script-')),
    database = join(dir, 'live.sqlite'),
    keyPath = join(dir, 'separate-secret/master.key'),
    bucket = join(dir, 'bucket');
  const key = createMasterKey(keyPath),
    store = openStore(database),
    registry = openChannelAccounts(database, { key });
  store.setPassword('recovery@example.test', 'recovery-test-password', true);
  registry.put('instagram', {
    ownerId: store.userByEmail('recovery@example.test').id,
    accountId: '17841411111111111',
    username: 'restore_fixture',
    accessToken: 'private-fixture-token',
    appSecret: 'a'.repeat(32),
  });
  await createBackup({
    database,
    keyPath,
    destination: bucket,
    secretVersion: 'projects/conversa-app-511802/secrets/conversa-master-key/versions/1',
    expectedKeySha: createHash('sha256').update(key).digest('hex'),
  });
  registry.close();
  store.close();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // This executable represents remote services; the verification container is real.
  writeFileSync(
    join(bin, 'gcloud'),
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
if(args[0]==='storage'&&args[1]==='cp') {
 const source=args.at(-2),destination=args.at(-1),name=source.split('/').at(-1);
 if(!['manifest.json','database.sqlite'].includes(name))process.exit(2);
 fs.copyFileSync(path.join(process.env.FIXTURE_BUCKET,name),destination);
} else if(args[0]==='secrets'&&args[1]==='versions'&&args[2]==='access'&&args[3]==='1') {
 const output=args.find(v=>v.startsWith('--out-file=')).slice('--out-file='.length);
 fs.copyFileSync(process.env.FIXTURE_SECRET,output);
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    FIXTURE_BUCKET: bucket,
    FIXTURE_SECRET: keyPath,
  };
  for (const name of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ])
    delete env[name];
  const run = () =>
    spawnSync(
      'bash',
      [
        resolve('ops/check-restore.sh'),
        'gs://fixture-backups/conversa/fixture-123456/manifest.json',
        process.env.CONVERSA_RESTORE_TEST_IMAGE || 'conversa-check',
      ],
      { env, encoding: 'utf8', timeout: 30000 },
    );
  try {
    const restored = run();
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /"verified":true/);
    assert.match(restored.stdout, /"accounts":1/);
    assert.ok(!restored.stdout.includes('private-fixture-token'));
    writeFileSync(keyPath, randomBytes(32));
    const wrong = run();
    assert.notEqual(wrong.status, 0);
    assert.ok(!wrong.stdout.includes('"verified":true'));
    writeFileSync(keyPath, key);
    const original = readFileSync(join(bucket, 'database.sqlite'));
    original[100] ^= 1;
    writeFileSync(join(bucket, 'database.sqlite'), original);
    const corrupted = run();
    assert.notEqual(corrupted.status, 0);
    assert.ok(!corrupted.stdout.includes('"verified":true'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
