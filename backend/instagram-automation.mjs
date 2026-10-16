import { graphOrigin } from './instagram-connection.mjs';
import { openCommentAutomation } from './comment-automation-store.mjs';

export const openInstagramAutomation = (path, options = {}) => openCommentAutomation(path, { ...options, channel: 'instagram' });

export async function sendInstagramPhase(config, job, request = fetch) {
  const publicPhase = job.status === 'public_sending';
  const endpoint = publicPhase ? `${job.comment_id}/replies` : `${config.accountId}/messages`;
  const payload = publicPhase ? { message: job.public_text } : { recipient: { comment_id: job.comment_id }, message: { text: job.dm_text } };
  let response, data;
  try {
    response = await request(`${graphOrigin}/${endpoint}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000)
    });
  } catch { return { uncertain: true, error: 'Sin confirmación de Instagram (red o tiempo de espera); revisar antes de reenviar.' }; }
  try { data = await response.json(); } catch { /* Never log provider response bodies. */ }
  if (!response.ok) {
    const code = Number.isSafeInteger(data?.error?.code) ? data.error.code : null;
    const subcode = Number.isSafeInteger(data?.error?.error_subcode) ? data.error.error_subcode : null;
    return { uncertain: response.status >= 500, error: `Instagram HTTP ${response.status}${code !== null ? `; código ${code}` : ''}${subcode !== null ? `; subcódigo ${subcode}` : ''}. ${code === 190 ? 'Revisa el token.' : 'Revisa permisos y restricciones de la cuenta.'}` };
  }
  const id = publicPhase ? data?.id : data?.message_id;
  if (typeof id !== 'string' || !id || data?.error) return { uncertain: true, error: 'Instagram respondió sin identificador de confirmación; revisar antes de reenviar.' };
  return { id };
}

export function createInstagramWorker({ automation, instagram, request = fetch, send = sendInstagramPhase, channelLabel = 'Instagram', onError = () => {} }) {
  let running = false, stopped = false, timer;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const config = instagram();
      if (!config) return;
      const job = automation.claim(config);
      if (!job) return;
      const result = await send(config, job, request);
      if (result.id) automation.complete(job, result.id);
      else automation.fail(job, result.uncertain, result.error);
    } catch { onError(`No se pudo procesar la cola de ${channelLabel}.`); }
    finally { running = false; }
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => void tick(), 1000); timer.unref(); } },
    async stop() { stopped = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 20)); }
  };
}
