// Experimental, explicit CLI probe. Never used by the automatic worker.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacebook, facebookGraph, safeFacebookError } from './facebook-connection.mjs';

const id = value => typeof value === 'string' && /^\d{5,30}(?:_\d{5,30}){0,2}$/.test(value);
export class MentionError extends Error {}

// Graph may return a plain comment ID for a request made with its compound ID.
export const sameCommentId = (a, b) => id(a) && id(b) && (a === b ||
  ((!a.includes('_') || !b.includes('_')) && a.split('_').at(-1) === b.split('_').at(-1)));

// Entries must come from the owner's private, signature-verified event store.
export function authorFromEvents(config, action, entries) {
  const authors = new Set();
  for (const entry of entries) {
    if (String(entry?.id) !== config.accountId) continue;
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change?.value;
      if (change?.field !== 'feed' || value?.item !== 'comment' || value.verb !== 'add' ||
          !sameCommentId(String(value.comment_id || ''), action.comment_id) ||
          String(value.post_id) !== action.media_id ||
          (value.parent_id && String(value.parent_id) !== action.media_id)) continue;
      const author = String(value.from?.id || value.sender_id || '');
      if (/^\d{5,30}$/.test(author)) authors.add(author);
    }
  }
  if (authors.size > 1) throw new MentionError('Los eventos guardados no coinciden en el autor; no se enviará una prueba.');
  return authors.values().next().value || null;
}

async function graph(config, path, request, body) {
  let response, data;
  try {
    response = await request(`${facebookGraph}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000)
    });
    data = await response.json();
  } catch { throw new MentionError('Sin confirmación de Facebook. Si hubo un envío, no se reintentará automáticamente.'); }
  if (!response.ok || data?.error) throw new MentionError(safeFacebookError(response.status, data));
  return data;
}

export function recognizedMention(tags, authorId) {
  if (tags === undefined || tags === null) return null;
  if (typeof tags !== 'object') return null;
  const visit = value => value && typeof value === 'object' && (
    String(value.id || '') === authorId || Object.values(value).some(visit)
  );
  return Boolean(visit(tags));
}

async function inspectReply(config, action, record, request) {
  const reply = await graph(config, `${record.replyId}?fields=id,parent{id},is_hidden,message_tags`, request);
  return {
    comentarioOriginal: action.comment_id,
    respuestaDePrueba: reply.id,
    dentroDelComentario: Boolean(sameCommentId(reply.parent?.id, action.comment_id)),
    oculta: typeof reply.is_hidden === 'boolean' ? reply.is_hidden : null,
    etiquetaReconocida: recognizedMention(reply.message_tags, record.authorId),
    fuenteAutor: record.authorSource || 'Graph',
    nota: 'La etiqueta y la notificación se comprueban por separado. Verifica el nombre enlazado y la alerta en Facebook.'
  };
}

export async function probeMention({ config, action, markerPath, mode = 'inspect', request = fetch, storedAuthorId = null }) {
  if (!['inspect', 'test'].includes(mode) || !id(config?.accountId) || !config?.ownerId ||
      !id(action?.comment_id) || !id(action?.media_id) || action.account_id !== config.accountId ||
      action.user_id !== config.ownerId) throw new MentionError('Indica un comentario registrado por el piloto de esta página y propietario.');
  let record;
  try { record = JSON.parse(readFileSync(markerPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new MentionError('El registro de prueba no se puede leer; se conserva para evitar duplicados.'); }
  if (record) {
    if (record.accountId !== config.accountId || record.commentId !== action.comment_id) throw new MentionError('El registro corresponde a otra prueba.');
    if (mode === 'test') throw new MentionError('Ya se intentó esta prueba. Usa inspect para consultar el resultado; no se reenviará.');
    if (!id(record.replyId)) throw new MentionError('La prueba anterior no tiene ID confirmado. Revisa el comentario en Facebook; no se reenviará.');
    return inspectReply(config, action, record, request);
  }
  if (mode === 'inspect') throw new MentionError('Todavía no hay una prueba de mención para este comentario.');

  const identity = await graph(config, 'me?fields=id', request);
  if (String(identity.id) !== config.accountId) throw new MentionError('El token guardado no corresponde a la página seleccionada.');
  const post = await graph(config, `${action.media_id}?fields=id,from{id}`, request);
  if (String(post.id) !== action.media_id || String(post.from?.id) !== config.accountId) throw new MentionError('Facebook no confirmó que la publicación pertenece a esta página.');
  const original = await graph(config, `${action.comment_id}?fields=id,from{id}`, request);
  if (!sameCommentId(String(original.id || ''), action.comment_id)) throw new MentionError('Graph devolvió otro identificador de comentario. No se envió la respuesta.');
  const graphAuthor = String(original.from?.id || '');
  if (graphAuthor && storedAuthorId && graphAuthor !== storedAuthorId) throw new MentionError('Graph y el evento guardado muestran autores distintos. No se envió la respuesta.');
  const authorId = graphAuthor || storedAuthorId || '';
  if (!/^\d{5,30}$/.test(authorId)) throw new MentionError('Graph omitió el autor y no hay un evento guardado que permita identificarlo. No se envió la respuesta.');
  if (authorId === config.accountId) throw new MentionError('El autor del comentario es la propia página. No se envió la respuesta.');
  const authorSource = graphAuthor ? 'Graph' : 'Webhook firmado guardado';
  // Persist BEFORE the only POST, including across crashes and concurrent CLI runs.
  record = { accountId: config.accountId, commentId: action.comment_id, authorId, authorSource, attemptedAt: new Date().toISOString(), status: 'sending' };
  try { writeFileSync(markerPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new MentionError('Otra ejecución ya reservó esta prueba; no se reenviará.');
    throw new MentionError('No se pudo guardar el registro privado. No se envió la respuesta.');
  }
  // Candidate syntax: support for personal authors is NOT assumed. Read back tags.
  const result = await graph(config, `${action.comment_id}/comments`, request,
    { message: `@[${authorId}] Prueba de mención de Conversa.` });
  if (!id(result.id)) throw new MentionError('Facebook no devolvió un ID de respuesta válido; revisa antes de cualquier otra prueba.');
  record = { ...record, status: 'confirmed', replyId: result.id };
  const temporary = markerPath + '.tmp';
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, markerPath);
  return inspectReply(config, action, record, request);
}

async function main() {
  const [mode, commentId] = process.argv.slice(2);
  if (!['test', 'inspect'].includes(mode) || (commentId && !id(commentId))) throw new MentionError('Uso: node backend/facebook-mention.mjs test|inspect [ID_COMENTARIO]');
  const database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
  const config = readFacebook(process.env.FACEBOOK_CONFIG_PATH || join(dirname(database), 'facebook.credentials.json'));
  if (!config) throw new MentionError('Configura primero la página de Facebook.');
  const db = new DatabaseSync(database, { readOnly: true });
  let action, storedAuthorId = null;
  try {
    action = db.prepare(`SELECT account_id,user_id,comment_id,media_id FROM facebook_actions
      WHERE account_id=? AND user_id=? AND public_id IS NOT NULL ${commentId ? 'AND comment_id=?' : ''}
      ORDER BY updated_at DESC LIMIT 1`).get(config.accountId, config.ownerId, ...(commentId ? [commentId] : []));
    if (action && mode === 'test') {
      const entries = db.prepare(`SELECT body FROM facebook_events WHERE user_id=? AND received_at>?
        ORDER BY received_at DESC LIMIT 2000`).all(config.ownerId, Date.now() - 7 * 86400_000)
        .flatMap(row => { try { return [JSON.parse(row.body)]; } catch { return []; } });
      storedAuthorId = authorFromEvents(config, action, entries);
    }
  } finally { db.close(); }
  if (!action) throw new MentionError('No hay un comentario con respuesta automática registrada para esta página.');
  const markerPath = join(dirname(database), `facebook-mention.${config.accountId}.${action.comment_id}.json`);
  console.log(JSON.stringify(await probeMention({ config, action, markerPath, mode, storedAuthorId }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof MentionError ? error.message : 'No se pudo completar la prueba de mención. No se reintentó ningún envío.');
    process.exitCode = 1;
  });
}
