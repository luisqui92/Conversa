import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';

test('Políticas por cuenta: omisiones visibles, intervalo por persona y palabras clave', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-policy-'));
  let now = Date.now();
  const store = openStore(join(dir, 'x.sqlite'), { now: () => now });
  store.setPassword('policy@example.test', 'policy-password', true);
  const config = {
      ownerId: store.userByEmail('policy@example.test').id,
      accountId: '17841411111111111',
      username: 'policy',
    },
    queue = openInstagramAutomation(join(dir, 'x.sqlite'), { now: () => now });
  const media = '17911111111111111';
  let seq = 0;
  const entry = ({ author = '555555555555', text = 'precio', time = now, post = media } = {}) => ({
    id: config.accountId,
    time: Math.floor(time / 1000),
    changes: [
      {
        field: 'comments',
        value: {
          id: String(18111111111111111n + BigInt(++seq)),
          from: { id: author },
          media: { id: post },
          text,
        },
      },
    ],
  });
  try {
    queue.saveRule(config, {
      mediaId: media,
      publicText: 'Respuesta',
      dmText: 'Detalles',
      enabled: true,
      expectedVersion: null,
      keywords: ['precio', 'visita'],
      cooldownSeconds: 86400,
    });
    now += 1000;
    const unrelated = entry({ text: 'buen video' });
    assert.equal(queue.enqueue(config, [unrelated]), 0);
    assert.equal(queue.report(config.ownerId).actions[0].status, 'skipped_keyword');
    const first = entry();
    assert.equal(queue.enqueue(config, [first]), 1);
    const job = queue.claim(config);
    queue.complete(job, 'public-1');
    queue.complete(queue.claim(config), 'private-1');
    const again = entry();
    assert.equal(queue.enqueue(config, [again]), 0);
    assert.equal(queue.report(config.ownerId).actions[0].status, 'skipped_person');
    assert.equal(queue.enqueue(config, [again]), 0);
    assert.equal(queue.panelReport(config.ownerId, config.accountId).summary.total, 3);
    const otherMedia = '17911111111111112';
    queue.saveRule(config, {
      mediaId: otherMedia,
      publicText: 'Otra oferta',
      dmText: 'Otro inmueble',
      enabled: true,
      expectedVersion: null,
      cooldownSeconds: 86400,
    });
    now += 1000;
    assert.equal(queue.enqueue(config, [entry({ post: otherMedia })]), 1);
    // Keep the first rule active while advancing time, then record a delayed new event explicitly.
    const due = now + 1000;
    now += 20 * 60000;
    assert.equal(queue.enqueue(config, [entry({ author: '666666666666', time: due })]), 0);
    assert.equal(queue.report(config.ownerId).actions[0].status, 'skipped_late');
    queue.enable(config, '17922222222222222', 'Public', 'DM', { keywords: [], cooldownSeconds: 0 });
    now += 1000;
    // Two earlier accepted flows count against the same account's rolling limit.
    for (let n = 0; n < 28; n++)
      assert.equal(
        queue.enqueue(config, [
          entry({ post: '17922222222222222', author: String(700000000000 + n) }),
        ]),
        1,
      );
    const limited = entry({ post: '17922222222222222', author: '888888888888' });
    assert.equal(queue.enqueue(config, [limited]), 0);
    assert.equal(queue.report(config.ownerId).actions[0].status, 'skipped_rate_limit');
    const before = store.notificationFeed(config.ownerId, [
      { channel: 'instagram', accountId: config.accountId },
    ]);
    assert.ok(before.notifications.some((n) => n.status === 'skipped_rate_limit'));
    queue.enqueue(config, [limited]);
    assert.equal(
      store.notificationFeed(config.ownerId, [
        { channel: 'instagram', accountId: config.accountId },
      ]).unread,
      before.unread,
    );
    now += 10 * 86400_000;
    assert.equal(queue.panelReport(config.ownerId, config.accountId).summary.total, 0);
    assert.ok(queue.panelReport(config.ownerId, config.accountId, { days: 30 }).summary.total > 0);
  } finally {
    queue.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
