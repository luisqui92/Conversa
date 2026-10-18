import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationCatalogue, publicationUrl } from './publication-catalogue.mjs';
import { buildLiveActivity } from '../dist/live-panel.mjs';
import {
  buildPublications,
  publicationCard,
  conversationDetail,
  safePublicationUrl,
  inboxUrl,
} from '../dist/publications.mjs';

const ok = (data) => ({ ok: true, json: async () => data });
const config = {
  id: 'connection-one',
  channel: 'facebook',
  accountId: '309667913276491',
  ownerId: 'one',
  username: 'My page',
  accessToken: 'private-token',
};
const post = {
  id: '309667913276491_1554451656687306',
  from: { id: config.accountId },
  message: 'Casa disponible\nTres habitaciones',
  full_picture: 'https://scontent.xx.fbcdn.net/photo.jpg',
  permalink_url: 'https://www.facebook.com/309667913276491/posts/1554451656687306',
  created_time: '2026-10-18T10:00:00Z',
};

test('Catálogo: solo lectura, secreto en cabecera, caché y recuperación de un post antiguo configurado', async () => {
  let now = 1000;
  const calls = [];
  const service = createPublicationCatalogue({
    now: () => now,
    request: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers.Authorization, 'Bearer private-token');
      assert.equal(options.method, undefined);
      assert.equal(options.redirect, 'error');
      assert.ok(!url.includes('private-token'));
      return url.includes('/posts?') ? ok({ data: [] }) : ok(post);
    },
  });
  const rules = [{ media_id: post.id }];
  const [first, concurrent] = await Promise.all([
    service.get(config, rules),
    service.get(config, rules),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(calls.length, 2);
  assert.equal(first.posts[0].title, 'Casa disponible');
  assert.equal(first.posts[0].image, post.full_picture);
  assert.equal(first.unavailable, false);
  await service.get(config, rules);
  assert.equal(calls.length, 2);
  now += 300_001;
  await service.get(config, rules);
  assert.equal(calls.length, 4);
  assert.ok(!JSON.stringify(first).includes('private-token'));
});

test('Catálogo: aísla dueño y credencial; no consulta IDs ajenos ni devuelve medios de otra cuenta', async () => {
  let calls = 0;
  const service = createPublicationCatalogue({
    request: async () => {
      calls++;
      return ok({
        data: [
          post,
          { ...post, id: '9999999999_1554451656687306' },
          { ...post, from: { id: '9999999999' } },
        ],
      });
    },
  });
  const rules = [{ media_id: '9999999999_1554451656687306' }, { media_id: 'https://evil.test' }];
  assert.equal((await service.get(config, rules)).posts.length, 1);
  assert.equal(calls, 1);
  await service.get({ ...config, ownerId: 'two' }, rules);
  await service.get({ ...config, accessToken: 'new-token' }, rules);
  assert.equal(calls, 3);
});

test('Instagram: usa miniatura de video y solo devuelve publicaciones de la cuenta autorizada', async () => {
  const service = createPublicationCatalogue({
    request: async () =>
      ok({
        data: [
          {
            id: '17968502288460067',
            username: 'test_ig',
            media_type: 'VIDEO',
            thumbnail_url: 'https://scontent.cdninstagram.com/preview.jpg',
            media_url: 'https://scontent.cdninstagram.com/video.mp4',
            caption: 'Mi publicación',
            permalink: 'https://www.instagram.com/reel/abc/',
          },
          { id: '17968502288460068', username: 'another', caption: 'No compartir' },
        ],
      }),
  });
  const result = await service.get({
    ...config,
    channel: 'instagram',
    username: 'test_ig',
    accountId: '17841456943841038',
  });
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].image, 'https://scontent.cdninstagram.com/preview.jpg');
  assert.equal(result.posts[0].type, 'VIDEO');
});

test('Un fallo de Meta devuelve estado seguro y reintenta sin exponer el error ni las credenciales', async () => {
  let now = 1000,
    calls = 0;
  const service = createPublicationCatalogue({
    now: () => now,
    request: async () => {
      calls++;
      throw new Error('private-token');
    },
  });
  const result = await service.get(config);
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.posts, []);
  assert.ok(!JSON.stringify(result).includes('private-token'));
  await service.get(config);
  assert.equal(calls, 1);
  now += 60_001;
  await service.get(config);
  assert.equal(calls, 2);
});

test('Los enlaces y fotos admiten solo HTTPS de Meta sin credenciales ni hosts engañosos', () => {
  for (const url of [
    'javascript:alert(1)',
    'http://www.facebook.com/post',
    'https://www.facebook.com.evil.test/x',
    'https://user:pass@www.facebook.com/x',
    'https://www.facebook.com:8443/x',
    'https://www.facebook.com/x?access_token=secret',
  ]) {
    assert.equal(publicationUrl(url), null);
    assert.equal(safePublicationUrl(url), null);
  }
  for (const url of [
    'https://fbcdn.net.evil.test/x',
    'https://evil.test/x',
    'data:image/svg+xml,evil',
  ]) {
    assert.equal(publicationUrl(url, true), null);
    assert.equal(safePublicationUrl(url, true), null);
  }
  assert.equal(inboxUrl('facebook', 'invalid'), null);
  assert.match(
    inboxUrl('facebook', config.accountId),
    /^https:\/\/business.facebook.com\/latest\/inbox/,
  );
  assert.ok(!inboxUrl('facebook', config.accountId).includes('m.me'));
});

test('Publicaciones: mantiene reglas sin fotos y separa acciones por cuenta y publicación', () => {
  const rule = {
    media_id: post.id,
    account_id: config.accountId,
    enabled: 1,
    enabled_at: 1000,
    public_text: 'Te mandé información.',
    dm_text: 'Hola',
  };
  const account = {
    configured: true,
    channel: 'facebook',
    accountId: config.accountId,
    username: 'Page',
  };
  const action = {
    account_id: config.accountId,
    comment_id: '1554451656687306_1111111111',
    media_id: post.id,
    created_at: 1000,
    status: 'sent',
    public_id: 'public',
    message_id: 'private',
    author_id: 'person-one',
  };
  const channels = {
    first: {
      account,
      report: { rules: [rule], actions: [action] },
      publications: { unavailable: true },
    },
    second: {
      account: { ...account, accountId: '9999999999' },
      report: { rules: [{ ...rule, enabled: 0 }], actions: [] },
    },
  };
  const activity = buildLiveActivity(channels);
  const posts = buildPublications(channels, activity);
  assert.equal(posts.length, 2);
  const first = posts.find((p) => p.connectionKey === 'first');
  assert.equal(first.items.length, 1);
  assert.equal(first.state, 'active');
  assert.equal(first.attention, 0);
  assert.equal(first.image, null);
  assert.equal(first.items[0].authorId, 'person-one');
  assert.equal(posts.find((p) => p.connectionKey === 'second').items.length, 0);
  assert.equal(posts.find((p) => p.connectionKey === 'second').state, 'paused');
});

test('La conversación distingue texto preparado de envíos confirmados y escapa contenido externo', () => {
  const item = {
    kind: 'comment',
    channel: 'facebook',
    author: '<script>bad</script>',
    text: '<img onerror=evil>',
    public_text: '@[123456789] Te mandé información.',
    dm_text: 'Mensaje preparado',
    status: 'public_failed',
  };
  const html = conversationDetail(item, null, { accountId: config.accountId });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img onerror'));
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(html.includes('Sin confirmar'));
  assert.ok(!html.includes('✓ Aceptado por Meta'));
  const card = publicationCard(
    {
      ...post,
      key: 'test',
      channel: 'facebook',
      accountName: '<bad>',
      title: '<script>bad</script>',
      items: [],
      state: 'available',
      image: null,
    },
    null,
  );
  assert.ok(!card.includes('<script>'));
  assert.ok(card.includes('Sin automatización'));
});
