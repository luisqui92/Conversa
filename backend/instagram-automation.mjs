import { graphOrigin } from './instagram-connection.mjs';
import { openCommentAutomation } from './comment-automation-store.mjs';

export const openInstagramAutomation = (path, options = {}) =>
  openCommentAutomation(path, { ...options, channel: 'instagram' });

export async function sendInstagramPhase(config, job, request = fetch) {
  const publicPhase = job.status === 'public_sending';
  const endpoint = publicPhase ? `${job.comment_id}/replies` : `${config.accountId}/messages`;
  const payload = publicPhase
    ? { message: job.public_text }
    : { recipient: { comment_id: job.comment_id }, message: { text: job.dm_text } };
  let response, data;
  try {
    response = await request(`${graphOrigin}/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      uncertain: true,
      error: 'Sin confirmación de Instagram (red o tiempo de espera); revisar antes de reenviar.',
    };
  }
  try {
    data = await response.json();
  } catch {
    /* Never log provider response bodies. */
  }
  if (!response.ok) {
    const code = Number.isSafeInteger(data?.error?.code) ? data.error.code : null;
    const subcode = Number.isSafeInteger(data?.error?.error_subcode)
      ? data.error.error_subcode
      : null;
    return {
      uncertain: response.status >= 500,
      error: `Instagram HTTP ${response.status}${code !== null ? `; código ${code}` : ''}${subcode !== null ? `; subcódigo ${subcode}` : ''}. ${code === 190 ? 'Revisa el token.' : 'Revisa permisos y restricciones de la cuenta.'}`,
    };
  }
  const id = publicPhase ? data?.id : data?.message_id;
  if (typeof id !== 'string' || !id || data?.error)
    return {
      uncertain: true,
      error: 'Instagram respondió sin identificador de confirmación; revisar antes de reenviar.',
    };
  return { id };
}

export function createInstagramWorker({
  automation,
  instagram,
  request = fetch,
  send = sendInstagramPhase,
  channelLabel = 'Instagram',
  onError = () => {},
  concurrency = 4,
}) {
  const active = new Map();
  let stopped = false,
    timer,
    cursor = 0;
  const health = { lastTick: null, lastError: null, processed: 0 };
  async function process(config) {
    try {
      const job = automation.claim(config);
      if (!job) return;
      const result = await send(config, job, request);
      if (result.id) automation.complete(job, result.id);
      else automation.fail(job, result.uncertain, result.error);
      health.processed++;
    } catch {
      health.lastError = new Date().toISOString();
      onError(`No se pudo procesar la cola de ${channelLabel}.`);
    }
  }
  async function tick() {
    if (stopped) return;
    health.lastTick = new Date().toISOString();
    let configs;
    try {
      const value = instagram();
      configs = (Array.isArray(value) ? value : [value]).filter((c) => c && c.enabled !== false);
    } catch {
      health.lastError = new Date().toISOString();
      onError(`No se pudieron cargar las cuentas de ${channelLabel}.`);
      return;
    }
    if (!configs.length) return;
    const tasks = [];
    for (let n = 0; n < configs.length && active.size < concurrency; n++) {
      const config = configs[(cursor + n) % configs.length],
        key = config.accountId + ':' + config.ownerId;
      if (active.has(key)) continue;
      const task = process(config).finally(() => active.delete(key));
      active.set(key, task);
      tasks.push(task);
    }
    cursor = (cursor + 1) % configs.length;
    await Promise.all(tasks);
  }
  return {
    tick,
    status: () => ({ ...health, active: active.size }),
    start() {
      if (!timer) {
        timer = setInterval(() => void tick(), 1000);
        timer.unref();
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...active.values()]);
    },
  };
}
