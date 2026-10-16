import { DatabaseSync } from 'node:sqlite';
import { graphOrigin } from './instagram-connection.mjs';

const numericId = value => typeof value === 'string' && /^\d{5,30}$/.test(value);
const visibleText = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);

// Uses the existing private database and user ownership; no credentials in these tables.
export function openInstagramAutomation(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS instagram_rules (
      account_id TEXT NOT NULL, media_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      public_text TEXT NOT NULL, dm_text TEXT NOT NULL, enabled INTEGER NOT NULL,
      enabled_at INTEGER NOT NULL, PRIMARY KEY(account_id,media_id));
    CREATE TABLE IF NOT EXISTS instagram_actions (
      account_id TEXT NOT NULL, comment_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      media_id TEXT NOT NULL, rule_enabled_at INTEGER NOT NULL, comment_at INTEGER NOT NULL,
      public_text TEXT NOT NULL, dm_text TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      public_id TEXT, message_id TEXT, last_error TEXT,
      PRIMARY KEY(account_id,comment_id));
    CREATE INDEX IF NOT EXISTS instagram_actions_status ON instagram_actions(status,created_at);
    CREATE INDEX IF NOT EXISTS instagram_actions_owner ON instagram_actions(user_id,created_at);`);
  function rule(config, mediaId) {
    return db.prepare('SELECT * FROM instagram_rules WHERE account_id=? AND media_id=? AND user_id=?').get(config.accountId, mediaId, config.ownerId);
  }
  return {
    enable(config, mediaId, publicText, dmText) {
      if (!numericId(config.accountId) || !numericId(mediaId) || !visibleText(publicText, 1000) || !visibleText(dmText, 1000)) throw new Error('Usa IDs válidos y textos de 1 a 1000 caracteres.');
      const previous = rule(config, mediaId);
      // A repeated installation command does not reset the activation cut-off.
      if (previous?.enabled && previous.public_text === publicText && previous.dm_text === dmText) return;
      const enabledAt = Math.max(now(), (previous?.enabled_at || 0) + 1);
      db.prepare(`INSERT INTO instagram_rules VALUES (?,?,?,?,?,1,?) ON CONFLICT(account_id,media_id) DO UPDATE SET
        user_id=excluded.user_id, public_text=excluded.public_text,dm_text=excluded.dm_text,enabled=1,enabled_at=excluded.enabled_at`)
        .run(config.accountId, mediaId, config.ownerId, publicText, dmText, enabledAt);
    },
    disable(config, mediaId) {
      return db.prepare('UPDATE instagram_rules SET enabled=0 WHERE account_id=? AND media_id=? AND user_id=?').run(config.accountId, mediaId, config.ownerId).changes;
    },
    enqueue(config, entries) {
      let added = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        // Old actions are not replayable: incoming events must also pass freshness and activation checks.
        db.prepare('DELETE FROM instagram_actions WHERE updated_at<?').run(now() - 7 * 86400_000);
        for (const entry of entries) {
          if (String(entry.id) !== config.accountId || !Number.isFinite(entry.time)) continue;
          const time = entry.time * 1000;
          if (time < now() - 10 * 60_000 || time > now() + 60_000) continue;
          for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
            const value = change?.value;
            if (change?.field !== 'comments' || !value || !numericId(value.id) || !numericId(value.media?.id)) continue;
            if (value.parent_id || value.media.media_product_type === 'LIVE' || !value.from?.id) continue;
            if (String(value.from.id) === config.accountId || (typeof value.from.username === 'string' && value.from.username.toLowerCase() === config.username.toLowerCase())) continue;
            const active = rule(config, value.media.id);
            if (!active?.enabled || time < Math.floor(active.enabled_at / 1000) * 1000) continue;
            // Pilot limit: at most 30 new comment workflows per account per hour.
            if (db.prepare('SELECT count(*) AS n FROM instagram_actions WHERE account_id=? AND created_at>?').get(config.accountId, now() - 3600_000).n >= 30) continue;
            const result = db.prepare(`INSERT OR IGNORE INTO instagram_actions
              (account_id,comment_id,user_id,media_id,rule_enabled_at,comment_at,public_text,dm_text,status,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`).run(config.accountId, value.id, config.ownerId, value.media.id, active.enabled_at, time, active.public_text, active.dm_text, now(), now());
            added += result.changes;
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return added;
    },
    claim(config) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE instagram_actions SET status=CASE status WHEN 'public_sending' THEN 'public_unknown' ELSE 'dm_unknown' END,
          last_error='Resultado incierto tras interrupción; revisar Instagram antes de cualquier reenvío.',updated_at=?
          WHERE status IN ('public_sending','dm_sending') AND updated_at<?`).run(now(), now() - 60_000);
        // At most 60 pending phases are scanned; ingestion is limited to 30 comments/hour.
        const pending = db.prepare(`SELECT * FROM instagram_actions WHERE user_id=? AND account_id=? AND status IN ('pending','public_done') ORDER BY created_at,rowid LIMIT 60`).all(config.ownerId, config.accountId);
        let job = null;
        for (const row of pending) {
          const active = rule(config, row.media_id);
          const cancelled = !active?.enabled || active.enabled_at !== row.rule_enabled_at;
          const expired = row.comment_at < now() - 10 * 60_000;
          if (cancelled || expired) {
            db.prepare('UPDATE instagram_actions SET status=?,updated_at=? WHERE account_id=? AND comment_id=?').run(cancelled ? 'cancelled' : 'expired', now(), row.account_id, row.comment_id);
            continue;
          }
          const stage = row.status === 'pending' ? 'public_sending' : 'dm_sending';
          db.prepare('UPDATE instagram_actions SET status=?,updated_at=? WHERE account_id=? AND comment_id=?').run(stage, now(), row.account_id, row.comment_id);
          job = { ...row, status: stage }; break;
        }
        db.exec('COMMIT'); return job;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    complete(job, providerId) {
      const column = job.status === 'public_sending' ? 'public_id' : 'message_id';
      const status = job.status === 'public_sending' ? 'public_done' : 'sent';
      db.prepare(`UPDATE instagram_actions SET status=?,${column}=?,last_error=NULL,updated_at=? WHERE account_id=? AND comment_id=? AND status=?`)
        .run(status, providerId, now(), job.account_id, job.comment_id, job.status);
    },
    fail(job, uncertain, reason) {
      const status = (job.status === 'public_sending' ? 'public_' : 'dm_') + (uncertain ? 'unknown' : 'failed');
      db.prepare('UPDATE instagram_actions SET status=?,last_error=?,updated_at=? WHERE account_id=? AND comment_id=? AND status=?')
        .run(status, reason, now(), job.account_id, job.comment_id, job.status);
    },
    report(userId) {
      return {
        rules: db.prepare('SELECT account_id,media_id,public_text,dm_text,enabled,enabled_at FROM instagram_rules WHERE user_id=? ORDER BY enabled_at DESC').all(userId),
        actions: db.prepare('SELECT account_id,comment_id,media_id,status,created_at,updated_at,public_id,message_id,last_error FROM instagram_actions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(userId)
      };
    },
    close() { db.close(); }
  };
}

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

export function createInstagramWorker({ automation, instagram, request = fetch, onError = () => {} }) {
  let running = false, stopped = false, timer;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const config = instagram();
      if (!config) return;
      const job = automation.claim(config);
      if (!job) return;
      const result = await sendInstagramPhase(config, job, request);
      if (result.id) automation.complete(job, result.id);
      else automation.fail(job, result.uncertain, result.error);
    } catch { onError('No se pudo procesar la cola de Instagram.'); }
    finally { running = false; }
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => void tick(), 1000); timer.unref(); } },
    async stop() { stopped = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 20)); }
  };
}
