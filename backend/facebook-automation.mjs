import { openCommentAutomation } from './comment-automation-store.mjs';
import { createInstagramWorker } from './instagram-automation.mjs';
import { facebookGraph, safeFacebookError } from './facebook-connection.mjs';

export function renderFacebookReply(text, comment) {
  if (!text.includes('{autor}')) return text;
  const authorId = comment?.from?.id;
  if (typeof authorId !== 'string' || !/^\d{5,30}$/.test(authorId)) return null;
  return text.replaceAll('{autor}', `@[${authorId}]`);
}

export function facebookCommentEntries(entries) {
  const normalized = [];
  for (const entry of entries) for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
    const v = change?.value;
    if (change?.field !== 'feed' || !v || v.item !== 'comment' || v.verb !== 'add') continue;
    if (v.parent_id && String(v.parent_id) !== String(v.post_id)) continue;
    normalized.push({ id: String(entry.id), time: Number(v.created_time ?? entry.time), changes: [{ field: 'comments', value: {
      id: String(v.comment_id || ''), media: { id: String(v.post_id || ''), media_product_type: 'FEED' },
      from: { id: String(v.from?.id || v.sender_id || '') }, text: v.message
    } }] });
  }
  return normalized;
}
export function openFacebookAutomation(path, options = {}) {
  const store = openCommentAutomation(path, { ...options, channel: 'facebook', renderPublicText: renderFacebookReply });
  return { ...store, enqueue: (config, entries) => store.enqueue(config, facebookCommentEntries(entries)) };
}
export async function sendFacebookPhase(config, job, request = fetch) {
  const publicPhase = job.status === 'public_sending';
  const endpoint = publicPhase ? `${job.comment_id}/comments` : `${config.accountId}/messages`;
  const payload = publicPhase ? { message: job.public_text } : { recipient: { comment_id: job.comment_id }, message: { text: job.dm_text } };
  let response, data;
  try {
    response = await request(`${facebookGraph}/${endpoint}`, { method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  } catch { return { uncertain: true, error: 'Sin confirmación de Facebook (red o tiempo de espera); revisar antes de reenviar.' }; }
  try { data = await response.json(); } catch { /* Provider bodies and credentials must not enter logs. */ }
  if (!response.ok) return { uncertain: response.status >= 500, error: safeFacebookError(response.status, data) };
  const id = publicPhase ? data?.id : data?.message_id;
  if (typeof id !== 'string' || !id || data?.error) return { uncertain: true, error: 'Facebook respondió sin identificador de confirmación; revisar antes de reenviar.' };
  return { id };
}
export const createFacebookWorker = ({ facebook, ...options }) => createInstagramWorker({ ...options, instagram: facebook, send: sendFacebookPhase, channelLabel: 'Facebook' });
