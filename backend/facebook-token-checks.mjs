import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFacebook, readFacebook } from './facebook-connection.mjs';
import {
  exchangeFacebookUserToken,
  inspectFacebookPageToken,
  connectFacebookDurable,
  renewFacebookConnection,
  checkStoredFacebookToken,
  facebookCredentialStatus,
} from './facebook-token.mjs';

const appId = '39748148371443102',
  appSecret = 'a'.repeat(32),
  pageId = '309667913276491';
const shortToken = 'test-short-user-secret',
  longToken = 'test-extended-user-secret',
  pageToken = 'test-durable-page-secret';
const clock = 1792242000000,
  now = () => clock;
const validInfo = {
  is_valid: true,
  type: 'PAGE',
  app_id: appId,
  profile_id: pageId,
  expires_at: 0,
  data_access_expires_at: 0,
};
const config = {
  accountId: pageId,
  username: 'Página de prueba',
  accessToken: pageToken,
  appId,
  appSecret,
  ownerId: 'private-owner',
  ownerEmail: 'owner@example.test',
  verifyToken: 'keep-webhook-verifier',
  checkedAt: new Date(clock - 3600_000).toISOString(),
};
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
function fixture(overrides = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    assert.ok(!url.includes(shortToken) && !url.includes(longToken) && !url.includes(appSecret));
    if (url.endsWith('/oauth/access_token')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'fb_exchange_token');
      assert.equal(body.get('client_id'), appId);
      assert.equal(body.get('client_secret'), appSecret);
      assert.equal(body.get('fb_exchange_token'), shortToken);
      return ok(overrides.exchange || { access_token: longToken, expires_in: 5184000 });
    }
    if (url.includes('/me/accounts?')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + longToken);
      return ok({
        data: [
          {
            id: pageId,
            name: 'Página de prueba',
            access_token: pageToken,
            tasks: ['MODERATE', 'MESSAGING'],
          },
        ],
      });
    }
    if (url.includes('/debug_token?')) {
      assert.equal(options.redirect, 'error');
      assert.equal(new URL(url).searchParams.get('input_token'), pageToken);
      assert.equal(options.headers.Authorization, `Bearer ${appId}|${appSecret}`);
      return ok({ data: overrides.debug || validInfo });
    }
    assert.ok(url.includes('/me?'));
    assert.equal(options.headers.Authorization, 'Bearer ' + pageToken);
    return ok({ id: overrides.identity || pageId, name: 'Página de prueba' });
  };
  return { calls, request };
}

test('Intercambia primero el token de usuario, obtiene la página y confirma caducidad con Meta', async () => {
  const f = fixture();
  const result = await connectFacebookDurable(
    { userToken: shortToken, appId, appSecret, pageId },
    f.request,
    now,
  );
  assert.ok(f.calls[0].url.endsWith('/oauth/access_token'));
  assert.ok(f.calls[1].url.includes('/me/accounts?'));
  assert.equal(result.accountId, pageId);
  assert.equal(result.accessToken, pageToken);
  assert.equal(result.tokenInfo.expiresAt, 0);
  assert.equal(result.tokenSource, 'long-lived-user-exchange');
  assert.ok(!JSON.stringify(result).includes(shortToken));
  assert.ok(!JSON.stringify(result).includes(longToken));
  assert.deepEqual(Object.keys(result.tokenInfo).sort(), [
    'checkedAt',
    'dataAccessExpiresAt',
    'expiresAt',
    'valid',
  ]);
});
test('No trata caducidad ausente como nunca y rechaza intercambio de solo unas horas', async () => {
  for (const exchange of [
    { access_token: longToken, expires_in: 3600 },
    { access_token: longToken },
    { expires_in: 5184000 },
  ]) {
    const f = fixture({ exchange });
    await assert.rejects(
      exchangeFacebookUserToken({ userToken: shortToken, appId, appSecret }, f.request),
      /no confirmó/,
    );
    assert.equal(f.calls.length, 1);
  }
  const f = fixture({ debug: { ...validInfo, expires_at: undefined } });
  await assert.rejects(
    connectFacebookDurable({ userToken: shortToken, appId, appSecret, pageId }, f.request, now),
    /no informó/,
  );
});
test('Rechaza tipo, app o página diferentes y diagnósticos de vigencia inválidos', async () => {
  for (const debug of [
    { ...validInfo, type: 'USER' },
    { ...validInfo, app_id: '99999999' },
    { ...validInfo, profile_id: '99999999' },
    { is_valid: 'true' },
    { ...validInfo, is_valid: false },
  ]) {
    const f = fixture({ debug });
    await assert.rejects(
      connectFacebookDurable({ userToken: shortToken, appId, appSecret, pageId }, f.request, now),
    );
  }
});
test('No instala una página con vencimiento inmediato o acceso a datos ya vencido', async () => {
  for (const debug of [
    { ...validInfo, expires_at: clock / 1000 + 3600 },
    { ...validInfo, data_access_expires_at: clock / 1000 - 1 },
  ]) {
    const f = fixture({ debug });
    await assert.rejects(
      connectFacebookDurable({ userToken: shortToken, appId, appSecret, pageId }, f.request, now),
    );
  }
});
test('Redacta errores HTTP, de red y de JSON durante el intercambio y la inspección', async () => {
  for (const failure of ['http', 'network', 'json']) {
    const request = async () => {
      if (failure === 'network') throw new Error(shortToken + ' ' + appSecret);
      if (failure === 'json')
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error(pageToken);
          },
        };
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: { code: 190, error_subcode: 463, message: longToken + ' ' + appSecret },
        }),
      };
    };
    const safe = (error) =>
      [shortToken, longToken, pageToken, appSecret].every(
        (secret) => !error.message.includes(secret),
      );
    await assert.rejects(
      exchangeFacebookUserToken({ userToken: shortToken, appId, appSecret }, request),
      safe,
    );
    await assert.rejects(inspectFacebookPageToken(config, request, now), safe);
  }
});
test('Renueva el archivo privado conservando propietario, webhook y otros ajustes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-durable-')),
    path = join(dir, 'facebook.credentials.json');
  try {
    writeFacebook(path, { ...config, accessToken: 'old-page-token', customSetting: 'preserve' });
    const f = fixture();
    const result = await renewFacebookConnection(path, shortToken, undefined, f.request, now);
    assert.equal(result.ownerId, config.ownerId);
    assert.equal(result.verifyToken, config.verifyToken);
    assert.equal(result.customSetting, 'preserve');
    assert.equal(result.accessToken, pageToken);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = readFileSync(path, 'utf8');
    assert.ok(!saved.includes(shortToken) && !saved.includes(longToken));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Si la renovación falla conserva el archivo anterior byte por byte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-durable-fail-')),
    path = join(dir, 'facebook.credentials.json');
  try {
    writeFacebook(path, config);
    const before = readFileSync(path, 'utf8');
    await assert.rejects(
      renewFacebookConnection(
        path,
        shortToken,
        appId,
        async () => {
          throw new Error(shortToken);
        },
        now,
      ),
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('No sobrescribe una reconexión que cambió durante las llamadas a Meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-durable-race-')),
    path = join(dir, 'facebook.credentials.json');
  try {
    writeFacebook(path, config);
    const f = fixture();
    const request = async (url, options) => {
      if (url.includes('/debug_token?'))
        writeFacebook(path, { ...config, accessToken: 'another-session-token' });
      return f.request(url, options);
    };
    await assert.rejects(renewFacebookConnection(path, shortToken, appId, request, now), /cambió/);
    assert.equal(readFacebook(path).accessToken, 'another-session-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('La comprobación guarda solo metadatos y refleja una autorización invalidada sin borrar el token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-token-check-')),
    path = join(dir, 'facebook.credentials.json');
  try {
    writeFacebook(path, config);
    const f = fixture({ debug: { is_valid: false } });
    const result = await checkStoredFacebookToken(path, f.request, now);
    assert.equal(result.accessToken, pageToken);
    assert.equal(result.tokenInfo.valid, false);
    assert.equal(facebookCredentialStatus(result, [], now).state, 'reconnect');
    assert.equal(result.verifyToken, config.verifyToken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('El estado distingue vencimientos, acceso a datos, fallo 190 reciente y comprobaciones anteriores', () => {
  const info = {
    valid: true,
    checkedAt: new Date(clock).toISOString(),
    expiresAt: 0,
    dataAccessExpiresAt: 0,
  };
  const withInfo = { ...config, tokenInfo: info };
  assert.equal(facebookCredentialStatus(config, [], now).state, 'unknown');
  assert.equal(facebookCredentialStatus(withInfo, [], now).state, 'ok');
  assert.equal(
    facebookCredentialStatus({ ...config, tokenInfo: { ...info, expiresAt: null } }, [], now).state,
    'unknown',
  );
  assert.equal(
    facebookCredentialStatus(
      { ...config, tokenInfo: { ...info, expiresAt: clock / 1000 - 1 } },
      [],
      now,
    ).state,
    'reconnect',
  );
  assert.equal(
    facebookCredentialStatus(
      { ...config, tokenInfo: { ...info, dataAccessExpiresAt: clock / 1000 + 86400 } },
      [],
      now,
    ).state,
    'expiring',
  );
  const failure = {
    account_id: pageId,
    updated_at: clock + 1000,
    last_error: 'Facebook HTTP 401; código 190; subcódigo 463.',
  };
  assert.equal(facebookCredentialStatus(withInfo, [failure], now).state, 'reconnect');
  assert.equal(
    facebookCredentialStatus(withInfo, [{ ...failure, account_id: '99999999' }], now).state,
    'ok',
  );
  assert.equal(
    facebookCredentialStatus(withInfo, [{ ...failure, updated_at: clock - 1000 }], now).state,
    'ok',
  );
  const output = JSON.stringify(facebookCredentialStatus(withInfo, [failure], now));
  for (const secret of [pageToken, appSecret, config.ownerEmail, config.verifyToken])
    assert.ok(!output.includes(secret));
});
