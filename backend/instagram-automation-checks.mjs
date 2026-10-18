import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { openStore } from './store.mjs';
import { makeServer } from './server.mjs';
import {
  openInstagramAutomation,
  createInstagramWorker,
  sendInstagramPhase,
} from './instagram-automation.mjs';

function context() {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-auto-'));
  const path = join(dir, 'test.sqlite');
  let now = Date.now();
  const store = openStore(path, { now: () => now });
  store.setPassword('owner@example.test', 'test-password-123', true);
  store.setPassword('other@example.test', 'test-password-456', true);
  const config = {
    ownerId: store.userByEmail('owner@example.test').id,
    accountId: '17841456943841038',
    username: 'test_owner',
    accessToken: 'test-secret',
    appSecret: 'test-secret-for-signature',
  };
  let automation = openInstagramAutomation(path, { now: () => now });
  const mediaId = '17968502288460067',
    publicText = 'Te mandé info al DM',
    dmText = 'hola soy yo yo puedo con todo';
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, ...options, parsed: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/replies')
          ? { id: 'public-id-test' }
          : { message_id: 'private-id-test', recipient_id: 'recipient-test' },
    };
  };
  const entry = (id = '18124786663917229', overrides = {}) => ({
    id: config.accountId,
    time: Math.floor(now / 1000),
    changes: [
      {
        field: 'comments',
        value: {
          id,
          from: { id: '1036716672763530', username: 'other_user' },
          media: { id: mediaId, media_product_type: 'REELS' },
          text: 'Holaaa',
          ...overrides,
        },
      },
    ],
  });
  return {
    config,
    store,
    path,
    mediaId,
    publicText,
    dmText,
    entry,
    calls,
    request,
    get automation() {
      return automation;
    },
    enable() {
      automation.enable(config, mediaId, publicText, dmText);
    },
    report() {
      return automation.report(config.ownerId);
    },
    worker(requestOverride = request) {
      return createInstagramWorker({
        automation,
        instagram: () => config,
        request: requestOverride,
      });
    },
    advance(ms) {
      now += ms;
    },
    reopen() {
      automation.close();
      automation = openInstagramAutomation(path, { now: () => now });
    },
    close() {
      automation.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Automatización real: selección, orden público → DM y prevención de duplicados', async (t) => {
  const c = context();
  try {
    assert.equal(c.automation.enqueue(c.config, [c.entry()]), 0);
    c.enable();
    await t.test(
      'Filtra cuenta, publicación, comentarios propios, respuestas, Live y eventos antiguos',
      () => {
        const old = c.entry('18124786663917230');
        old.time -= 86400;
        const otherAccount = c.entry('18124786663917231');
        otherAccount.id = '9999999999';
        const message = c.entry('18124786663917232');
        message.changes[0].field = 'messages';
        const entries = [
          old,
          otherAccount,
          message,
          c.entry('18124786663917233', { media: { id: '99999999' } }),
          c.entry('18124786663917234', { from: { id: c.config.accountId } }),
          c.entry('18124786663917235', { from: { id: '99999999', username: 'TEST_OWNER' } }),
          c.entry('18124786663917236', { parent_id: '99999999' }),
          c.entry('18124786663917237', { media: { id: c.mediaId, media_product_type: 'LIVE' } }),
        ];
        assert.equal(c.automation.enqueue(c.config, entries), 0);
      },
    );
    await t.test(
      'No duplica aunque Meta cambie la fecha del sobre o el texto en un reenvío',
      () => {
        assert.equal(c.automation.enqueue(c.config, [c.entry()]), 1);
        c.advance(1000);
        assert.equal(
          c.automation.enqueue(c.config, [c.entry(undefined, { text: 'texto editado' })]),
          0,
        );
      },
    );
    await t.test(
      'Primero confirma respuesta pública y después envía un private reply por comment_id',
      async () => {
        const worker = c.worker();
        await worker.tick();
        assert.equal(c.calls.length, 1);
        assert.ok(c.calls[0].url.endsWith('/18124786663917229/replies'));
        assert.deepEqual(c.calls[0].parsed, { message: c.publicText });
        assert.equal(c.report().actions[0].status, 'public_done');
        await worker.tick();
        assert.equal(c.calls.length, 2);
        assert.ok(c.calls[1].url.endsWith('/' + c.config.accountId + '/messages'));
        assert.deepEqual(c.calls[1].parsed, {
          recipient: { comment_id: '18124786663917229' },
          message: { text: c.dmText },
        });
        assert.equal(c.report().actions[0].status, 'sent');
        assert.equal(c.report().actions[0].public_id, 'public-id-test');
        assert.equal(c.report().actions[0].message_id, 'private-id-test');
        await worker.tick();
        assert.equal(c.calls.length, 2);
      },
    );
    await t.test('Los informes solo contienen reglas y acciones del propietario', () => {
      const other = c.store.userByEmail('other@example.test');
      assert.deepEqual(c.automation.report(other.id), { rules: [], actions: [] });
    });
  } finally {
    c.close();
  }
});

test('Errores, reinicios, pausa y límites de la automatización', async (t) => {
  async function withContext(fn) {
    const c = context();
    try {
      c.enable();
      c.automation.enqueue(c.config, [c.entry()]);
      await fn(c);
    } finally {
      c.close();
    }
  }
  await t.test('Un fallo público impide enviar DM y no genera reintentos automáticos', () =>
    withContext(async (c) => {
      let calls = 0;
      const worker = c.worker(async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: { code: 200, message: c.config.accessToken } }),
        };
      });
      await worker.tick();
      await worker.tick();
      assert.equal(calls, 1);
      assert.equal(c.report().actions[0].status, 'public_failed');
      assert.ok(!JSON.stringify(c.report()).includes(c.config.accessToken));
    }),
  );
  await t.test('Un DM rechazado conserva la respuesta pública y no repite ninguna fase', () =>
    withContext(async (c) => {
      const worker = c.worker(async (url, options) =>
        url.endsWith('/replies')
          ? c.request(url, options)
          : { ok: false, status: 400, json: async () => ({ error: { code: 10 } }) },
      );
      await worker.tick();
      await worker.tick();
      await worker.tick();
      const row = c.report().actions[0];
      assert.equal(row.status, 'dm_failed');
      assert.equal(row.public_id, 'public-id-test');
      assert.equal(row.message_id, null);
    }),
  );
  await t.test('Un timeout deja resultado incierto y nunca repite automáticamente', () =>
    withContext(async (c) => {
      let calls = 0;
      const worker = c.worker(async () => {
        calls++;
        throw new Error(c.config.accessToken);
      });
      await worker.tick();
      await worker.tick();
      assert.equal(calls, 1);
      assert.equal(c.report().actions[0].status, 'public_unknown');
      assert.ok(!JSON.stringify(c.report()).includes(c.config.accessToken));
    }),
  );
  await t.test(
    'Reiniciar entre confirmación pública y DM continúa sin repetir la respuesta pública',
    () =>
      withContext(async (c) => {
        await c.worker().tick();
        c.reopen();
        await c.worker().tick();
        assert.equal(c.calls.length, 2);
        assert.equal(c.report().actions[0].status, 'sent');
      }),
  );
  await t.test(
    'Una fase iniciada sin confirmación al reiniciar queda incierta tras 60 segundos',
    () =>
      withContext(async (c) => {
        const job = c.automation.claim(c.config);
        assert.equal(job.status, 'public_sending');
        c.reopen();
        c.advance(61_000);
        await c.worker().tick();
        assert.equal(c.calls.length, 0);
        assert.equal(c.report().actions[0].status, 'public_unknown');
      }),
  );
  await t.test('Pausar cancela una acción pendiente sin enviar nada', () =>
    withContext(async (c) => {
      c.automation.disable(c.config, c.mediaId);
      await c.worker().tick();
      assert.equal(c.calls.length, 0);
      assert.equal(c.report().actions[0].status, 'cancelled');
    }),
  );
  await t.test(
    'Cambiar la oferta cancela pendientes anteriores y conserva el texto de cada acción',
    () =>
      withContext(async (c) => {
        c.automation.enable(c.config, c.mediaId, 'Otra respuesta', 'Otro DM');
        await c.worker().tick();
        assert.equal(c.calls.length, 0);
        assert.equal(c.report().actions[0].status, 'cancelled');
        assert.equal(c.automation.enqueue(c.config, [c.entry('18124786663917300')]), 1);
        await c.worker().tick();
        assert.equal(c.calls[0].parsed.message, 'Otra respuesta');
      }),
  );
  await t.test('Dos trabajadores no reclaman a la vez la misma fase', () =>
    withContext(async (c) => {
      let release;
      const slow = c.worker(async (url, options) => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return c.request(url, options);
      });
      const first = slow.tick();
      await c.worker().tick();
      assert.equal(c.calls.length, 0);
      release();
      await first;
      assert.equal(c.calls.length, 1);
      assert.equal(c.report().actions[0].status, 'public_done');
    }),
  );
  await t.test('Una acción envejecida no sale y el piloto limita a 30 comentarios por hora', () =>
    withContext(async (c) => {
      c.advance(11 * 60_000);
      await c.worker().tick();
      assert.equal(c.report().actions[0].status, 'expired');
      assert.equal(c.calls.length, 0);
      const entries = Array.from({ length: 50 }, (_, n) =>
        c.entry(String(18124786663918000n + BigInt(n))),
      );
      assert.equal(c.automation.enqueue(c.config, entries), 29);
    }),
  );
  await t.test(
    'Las credenciales solo van en Authorization y un 2xx sin ID no se marca como enviado',
    () =>
      withContext(async (c) => {
        const job = c.automation.claim(c.config);
        const result = await sendInstagramPhase(c.config, job, async (url, options) => {
          assert.ok(!url.includes(c.config.accessToken));
          assert.equal(options.headers.Authorization, 'Bearer ' + c.config.accessToken);
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        });
        assert.equal(result.uncertain, true);
        assert.equal(result.id, undefined);
      }),
  );
});

test('El webhook firmado encola sin bloquearse en los envíos y los diagnósticos requieren sesión', async () => {
  const c = context();
  const server = makeServer({
    store: c.store,
    instagram: () => c.config,
    automation: c.automation,
  });
  function request(method, url, body = '', headers = {}) {
    return new Promise((resolve) => {
      const req = Readable.from([Buffer.from(body)]);
      Object.assign(req, { method, url, headers, socket: { remoteAddress: 'test' } });
      const res = {
        headersSent: false,
        destroyed: false,
        writeHead(status) {
          this.status = status;
          this.headersSent = true;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      server.emit('request', req, res);
    });
  }
  try {
    c.enable();
    const body = JSON.stringify({ object: 'instagram', entry: [c.entry()] });
    const headers = {
      'x-hub-signature-256':
        'sha256=' + createHmac('sha256', c.config.appSecret).update(body).digest('hex'),
    };
    assert.equal((await request('POST', '/api/webhooks/instagram', body, headers)).status, 200);
    assert.equal(c.calls.length, 0);
    assert.equal(c.report().actions[0].status, 'pending');
    assert.equal((await request('GET', '/api/integrations/instagram/automation')).status, 401);
    const other = c.store.login('other@example.test', 'test-password-456', 'test');
    assert.deepEqual(
      (
        await request('GET', '/api/integrations/instagram/automation', '', {
          cookie: '__Host-conversa=' + other.token,
        })
      ).body,
      { rules: [], actions: [] },
    );
  } finally {
    server.close();
    c.close();
  }
});
