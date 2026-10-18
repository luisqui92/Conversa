import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Run the actual deployment's one-shot Docker commands with harmless services.
// An interactive Docker client used to swallow the rest of an SSH script's stdin.
test('Los comandos de despliegue dejan ejecutar el paso posterior en una sesión SSH por stdin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'conversa-deploy-stdin-'));
  const image = process.env.CONVERSA_RESTORE_TEST_IMAGE || 'conversa-check';
  const config = join(directory, 'compose.yaml');
  const service = {
    image,
    network_mode: 'none',
    entrypoint: ['node', '-e', 'setTimeout(()=>process.exit(0),100)'],
    command: [],
  };
  writeFileSync(
    config,
    JSON.stringify({
      name: 'conversa-stdin-' + process.pid,
      services: { web: service, init: service },
    }),
  );
  const env = { ...process.env };
  for (const key of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ])
    delete env[key];
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const commands = readFileSync('deploy-vm.sh', 'utf8').match(
    /docker compose -f compose\.vm\.yaml run[^\n;]*/g,
  );
  assert.equal(commands.length, 2, 'Validate both the web configuration and migration commands.');
  const script =
    'set -e\n' +
    commands
      .map(
        (command, index) =>
          command.replace('-f compose.vm.yaml', '-f ' + quote(config)) +
          '\nprintf ' +
          quote('NEXT_STAGE_' + index + '\\n') +
          '\n',
      )
      .join('');
  try {
    const result = spawnSync('bash', ['-s'], {
      input: script,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    for (let i = 0; i < commands.length; i++)
      assert.match(result.stdout, new RegExp('NEXT_STAGE_' + i));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
