import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMention, recognizedMention } from './facebook-mention.mjs';

const config = { accountId: '123456789012345', ownerId: 'owner', accessToken: 'private-test-token' };
const action = { account_id: config.accountId, user_id: config.ownerId,
  media_id: config.accountId + '_234567890123456', comment_id: '234567890123456_345678901234567' };
const authorId = '456789012345678', replyId = '234567890123456_567890123456789';
const ok = data => ({ ok: true, status: 200, json: async () => data });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-mention-'));
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    assert.ok(!url.includes(config.accessToken));
    assert.equal(options.headers.Authorization, 'Bearer ' + config.accessToken);
    if (url.includes('/me?')) return ok({ id: config.accountId });
    if (url.includes('/' + action.media_id + '?')) return ok({ id: action.media_id, from: { id: config.accountId } });
    if (url.includes('/' + action.comment_id + '?')) return ok({ id: action.comment_id, from: { id: authorId } });
    if (options.method === 'POST') return ok({ id: replyId });
    return ok({ id: replyId, parent: { id: action.comment_id }, is_hidden: false, message_tags: [{ id: authorId }] });
  };
  return { dir, calls, args: { config, action, markerPath: join(dir, 'probe.json'), mode: 'test', request },
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Comprueba identidad y propiedad, menciona solo al autor y verifica el resultado sin DM', async () => {
  const f = fixture();
  try {
    const result = await probeMention(f.args);
    assert.equal(result.etiquetaReconocida, true); assert.equal(result.dentroDelComentario, true);
    const posts = f.calls.filter(c => c.options.method === 'POST'); assert.equal(posts.length, 1);
    assert.ok(posts[0].url.endsWith('/' + action.comment_id + '/comments'));
    assert.deepEqual(JSON.parse(posts[0].options.body), { message: `@[${authorId}] Prueba de mención de Conversa.` });
    assert.equal(statSync(f.args.markerPath).mode & 0o777, 0o600);
    assert.ok(!readFileSync(f.args.markerPath, 'utf8').includes(config.accessToken));
    await assert.rejects(probeMention(f.args), /Ya se intentó/);
    await probeMention({ ...f.args, mode: 'inspect' });
    assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
  } finally { f.close(); }
});
test('No confunde texto, etiquetas de otra persona o datos ausentes con mención confirmada', () => {
  assert.equal(recognizedMention(undefined, authorId), null);
  assert.equal(recognizedMention('Nombre', authorId), null);
  assert.equal(recognizedMention([], authorId), false);
  assert.equal(recognizedMention([{ id: '999999999999999' }], authorId), false);
  assert.equal(recognizedMention({ 0: [{ id: authorId }] }, authorId), true);
});
test('Rechaza comentarios de otra cuenta/propietario y lectura no crea una prueba', async () => {
  const f = fixture();
  try {
    await assert.rejects(probeMention({ ...f.args, action: { ...action, user_id: 'other' } }), /propietario/);
    await assert.rejects(probeMention({ ...f.args, mode: 'inspect' }), /Todavía no hay/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('Sin identidad de página, propiedad del post o autor, no hay POST', async () => {
  for (const target of ['identity', 'post', 'author']) {
    const f = fixture();
    try {
      const request = async (url, options) => {
        if (target === 'identity' && url.includes('/me?')) return ok({ id: authorId });
        if (target === 'post' && url.includes('/' + action.media_id + '?')) return ok({ id: action.media_id, from: { id: authorId } });
        if (target === 'author' && url.includes('/' + action.comment_id + '?')) return ok({ id: action.comment_id });
        return f.args.request(url, options);
      };
      await assert.rejects(probeMention({ ...f.args, request }));
      assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 0);
    } finally { f.close(); }
  }
});
test('Dos ejecuciones concurrentes no duplican el POST', async () => {
  const f = fixture();
  try {
    const result = await Promise.allSettled([probeMention(f.args), probeMention(f.args)]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
  } finally { f.close(); }
});
test('Un envío incierto o rechazado no se repite y no expone errores privados', async () => {
  for (const failure of ['network', 'rejected', 'no-id']) {
    const f = fixture();
    try {
      const request = async (url, options) => {
        if (options.method !== 'POST') return f.args.request(url, options);
        if (failure === 'network') throw new Error(config.accessToken);
        if (failure === 'no-id') return ok({ success: true });
        return { ok: false, status: 400, json: async () => ({ error: { code: 190, message: config.accessToken } }) };
      };
      await assert.rejects(probeMention({ ...f.args, request }), error => !error.message.includes(config.accessToken));
      await assert.rejects(probeMention(f.args), /Ya se intentó/);
      assert.equal(JSON.parse(readFileSync(f.args.markerPath, 'utf8')).status, 'sending');
    } finally { f.close(); }
  }
});
