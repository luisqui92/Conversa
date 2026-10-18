import { createHash } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { installAutomation } from './automation-schema.mjs';
import { matchesKeyword } from './keyword-match.mjs';

const numericId = (value) => typeof value === 'string' && /^\d{5,30}$/.test(value);
const visibleText = (value, limit) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= limit &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
export const automationRuleVersion = (rule) =>
  rule
    ? createHash('sha256')
        .update(
          JSON.stringify([
            rule.account_id,
            rule.media_id,
            rule.public_text,
            rule.dm_text,
            rule.enabled,
            rule.enabled_at,
            rule.keywords || '[]',
            rule.cooldown_seconds ?? 0,
          ]),
        )
        .digest('hex')
    : null;

export function openCommentAutomation(
  path,
  { now = Date.now, channel = 'instagram', renderPublicText = (text) => text } = {},
) {
  if (!['instagram', 'facebook'].includes(channel)) throw new Error('Canal no válido.');
  const connection = openDatabase(path),
    db = connection.db;
  installAutomation(db);
  const objectId =
    channel === 'facebook'
      ? (value) => typeof value === 'string' && /^\d{5,30}(?:_\d{5,30}){0,2}$/.test(value)
      : numericId;
  const rule = (config, mediaId) =>
    db
      .prepare(
        'SELECT * FROM channel_rules WHERE channel=? AND account_id=? AND media_id=? AND user_id=?',
      )
      .get(channel, config.accountId, mediaId, config.ownerId);
  const ruleFields =
    'account_id,media_id,public_text,dm_text,enabled,enabled_at,keywords,cooldown_seconds';
  const actionFields =
    'account_id,comment_id,media_id,status,created_at,updated_at,public_id,message_id,last_error,public_text,dm_text,author_id';
  const api = {
    enable(config, mediaId, publicText, dmText, options = {}) {
      if (
        !numericId(config.accountId) ||
        !objectId(mediaId) ||
        !visibleText(publicText, 1000) ||
        !visibleText(dmText, 1000)
      )
        throw new Error('Usa IDs válidos y textos de 1 a 1000 caracteres.');
      const previous = rule(config, mediaId),
        keywords = JSON.stringify(
          options.keywords ?? (previous ? JSON.parse(previous.keywords) : []),
        );
      // Legacy low-level CLI calls preserve their previous policy. Web-created rules default to 24 hours.
      const cooldown = options.cooldownSeconds ?? previous?.cooldown_seconds ?? 0;
      if (
        previous?.enabled &&
        previous.public_text === publicText &&
        previous.dm_text === dmText &&
        previous.keywords === keywords &&
        previous.cooldown_seconds === cooldown
      )
        return;
      const enabledAt = Math.max(now(), (previous?.enabled_at || 0) + 1);
      db.prepare(
        `INSERT INTO channel_rules VALUES (?,?,?,?,?,?,1,?,?,?) ON CONFLICT(channel,account_id,media_id) DO UPDATE SET
        public_text=excluded.public_text,dm_text=excluded.dm_text,enabled=1,enabled_at=excluded.enabled_at,keywords=excluded.keywords,cooldown_seconds=excluded.cooldown_seconds
        WHERE channel_rules.user_id=excluded.user_id`,
      ).run(
        channel,
        config.accountId,
        mediaId,
        config.ownerId,
        publicText,
        dmText,
        enabledAt,
        keywords,
        cooldown,
      );
    },
    disable(config, mediaId) {
      return db
        .prepare(
          'UPDATE channel_rules SET enabled=0 WHERE channel=? AND account_id=? AND media_id=? AND user_id=?',
        )
        .run(channel, config.accountId, mediaId, config.ownerId).changes;
    },
    saveRule(config, input) {
      const invalid = (message) => Object.assign(new Error(message), { status: 422 });
      if (
        !input ||
        !objectId(input.mediaId) ||
        !visibleText(input.publicText, 1000) ||
        !visibleText(input.dmText, 1000) ||
        typeof input.enabled !== 'boolean' ||
        !(
          input.expectedVersion === null ||
          (typeof input.expectedVersion === 'string' &&
            /^[a-f0-9]{64}$/.test(input.expectedVersion))
        )
      )
        throw invalid('Revisa el ID de publicación y los dos mensajes (de 1 a 1000 caracteres).');
      if (
        channel === 'facebook' &&
        input.mediaId.includes('_') &&
        input.mediaId.split('_')[0] !== config.accountId
      )
        throw invalid('El ID de publicación debe corresponder a la página conectada.');
      const keywords = input.keywords ?? [],
        cooldown = input.cooldownSeconds ?? 86400;
      if (
        !Array.isArray(keywords) ||
        keywords.length > 20 ||
        keywords.some((k) => !visibleText(k, 60)) ||
        !Number.isInteger(cooldown) ||
        cooldown < 0 ||
        cooldown > 30 * 86400
      )
        throw invalid('Usa hasta 20 palabras clave y un intervalo de 0 a 30 días.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = rule(config, input.mediaId);
        if (automationRuleVersion(previous) !== input.expectedVersion)
          throw Object.assign(
            new Error('Esta automatización cambió en otra pestaña. Actualiza y vuelve a abrirla.'),
            { status: 409 },
          );
        if (!previous && !input.enabled)
          throw invalid('Crea primero la automatización antes de pausarla.');
        api.enable(config, input.mediaId, input.publicText, input.dmText, {
          keywords,
          cooldownSeconds: cooldown,
        });
        if (!input.enabled) api.disable(config, input.mediaId);
        db.exec('COMMIT');
        const saved = rule(config, input.mediaId);
        return { ...saved, user_id: undefined, version: automationRuleVersion(saved) };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    notificationAction(userId, accountId, commentId) {
      return (
        db
          .prepare(
            `SELECT ${actionFields} FROM channel_actions WHERE channel=? AND user_id=? AND account_id=? AND comment_id=?`,
          )
          .get(channel, userId, accountId, commentId) || null
      );
    },
    panelReport(userId, accountId, { days = 7 } = {}) {
      if (![7, 30, 90].includes(days)) days = 7;
      const periodStart = now() - days * 86400_000;
      const rules = db
        .prepare(
          `SELECT ${ruleFields} FROM channel_rules WHERE channel=? AND user_id=? AND account_id=? ORDER BY enabled_at DESC`,
        )
        .all(channel, userId, accountId)
        .map((r) => ({ ...r, version: automationRuleVersion(r) }));
      const actions = db
        .prepare(
          `SELECT ${actionFields} FROM channel_actions WHERE channel=? AND user_id=? AND account_id=? AND created_at>=? ORDER BY created_at DESC,rowid DESC LIMIT 50`,
        )
        .all(channel, userId, accountId, periodStart);
      const summary = db
        .prepare(
          `SELECT count(*) AS total,count(public_id) AS publicConfirmed,count(message_id) AS dmConfirmed,
        coalesce(sum(status IN ('pending','public_sending','public_done','dm_sending')),0) AS pending,
        coalesce(sum(status IN ('public_failed','dm_failed','public_unknown','dm_unknown','skipped_rate_limit','skipped_late','skipped_author')),0) AS attention,
        coalesce(sum(status LIKE 'skipped_%'),0) AS skipped FROM channel_actions WHERE channel=? AND user_id=? AND account_id=? AND created_at>=?`,
        )
        .get(channel, userId, accountId, periodStart);
      return { rules, actions, summary, periodStart, days };
    },
    enqueue(config, entries) {
      let added = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM channel_actions WHERE updated_at<?').run(now() - 90 * 86400_000);
        for (const entry of entries) {
          if (String(entry.id) !== config.accountId || !Number.isFinite(entry.time)) continue;
          const time = entry.time * 1000;
          for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
            const value = change?.value;
            if (
              change?.field !== 'comments' ||
              !value ||
              !objectId(value.id) ||
              !objectId(value.media?.id)
            )
              continue;
            if (
              value.parent_id ||
              value.media.media_product_type === 'LIVE' ||
              String(value.from?.id) === config.accountId ||
              (typeof value.from?.username === 'string' &&
                value.from.username.toLowerCase() === config.username.toLowerCase())
            )
              continue;
            const active = rule(config, value.media.id);
            if (!active?.enabled || time < Math.floor(active.enabled_at / 1000) * 1000) continue;
            if (
              db
                .prepare(
                  'SELECT 1 FROM channel_actions WHERE channel=? AND account_id=? AND comment_id=?',
                )
                .get(channel, config.accountId, value.id)
            )
              continue;
            let status = 'pending',
              reason = null;
            const author = String(value.from?.id || ''),
              publicText = renderPublicText(active.public_text, value);
            if (!numericId(author) || !visibleText(publicText, 1000)) {
              status = 'skipped_author';
              reason = 'No se pudo identificar con seguridad al autor o generar la respuesta.';
            } else if (time < now() - 10 * 60_000 || time > now() + 60_000) {
              status = 'skipped_late';
              reason = 'El evento llegó fuera de la ventana segura de procesamiento.';
            } else if (
              JSON.parse(active.keywords).length &&
              !JSON.parse(active.keywords).some((k) => matchesKeyword(value.text || '', k))
            ) {
              status = 'skipped_keyword';
              reason = 'El comentario no coincide con las palabras clave.';
            } else if (
              active.cooldown_seconds > 0 &&
              db
                .prepare(
                  `SELECT 1 FROM channel_actions WHERE channel=? AND account_id=? AND media_id=? AND author_id=? AND created_at>?
              AND status NOT LIKE 'skipped_%' AND status NOT IN ('cancelled','expired') LIMIT 1`,
                )
                .get(
                  channel,
                  config.accountId,
                  value.media.id,
                  author,
                  now() - active.cooldown_seconds * 1000,
                )
            ) {
              status = 'skipped_person';
              reason =
                'Esta persona ya tiene un flujo para esta publicación dentro del intervalo configurado.';
            } else if (
              db
                .prepare(
                  `SELECT count(*) AS n FROM channel_actions WHERE channel=? AND account_id=? AND created_at>? AND status NOT LIKE 'skipped_%'`,
                )
                .get(channel, config.accountId, now() - 3600_000).n >= 30
            ) {
              status = 'skipped_rate_limit';
              reason =
                'Se alcanzó el límite de 30 flujos por hora de esta cuenta. Requiere atención; no se reenvía automáticamente.';
            }
            db.prepare(
              `INSERT INTO channel_actions(channel,account_id,comment_id,user_id,media_id,rule_enabled_at,comment_at,public_text,dm_text,status,created_at,updated_at,last_error,author_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              channel,
              config.accountId,
              value.id,
              config.ownerId,
              value.media.id,
              active.enabled_at,
              time,
              publicText || active.public_text,
              active.dm_text,
              status,
              now(),
              now(),
              reason,
              author || null,
            );
            if (status === 'pending') added++;
          }
        }
        db.exec('COMMIT');
        return added;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    claim(config) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          `UPDATE channel_actions SET status=CASE status WHEN 'public_sending' THEN 'public_unknown' ELSE 'dm_unknown' END,
          last_error='Resultado incierto tras interrupción; revisar la plataforma antes de cualquier reenvío.',updated_at=?
          WHERE channel=? AND user_id=? AND account_id=? AND status IN ('public_sending','dm_sending') AND updated_at<?`,
        ).run(now(), channel, config.ownerId, config.accountId, now() - 60_000);
        const pending = db
          .prepare(
            `SELECT * FROM channel_actions WHERE channel=? AND user_id=? AND account_id=? AND status IN ('pending','public_done') ORDER BY created_at,rowid LIMIT 60`,
          )
          .all(channel, config.ownerId, config.accountId);
        let job = null;
        for (const row of pending) {
          const active = rule(config, row.media_id),
            cancelled = !active?.enabled || active.enabled_at !== row.rule_enabled_at,
            expired = row.comment_at < now() - 10 * 60_000;
          if (cancelled || expired) {
            db.prepare(
              'UPDATE channel_actions SET status=?,updated_at=? WHERE channel=? AND account_id=? AND comment_id=? AND user_id=?',
            ).run(
              cancelled ? 'cancelled' : 'expired',
              now(),
              channel,
              row.account_id,
              row.comment_id,
              config.ownerId,
            );
            continue;
          }
          const stage = row.status === 'pending' ? 'public_sending' : 'dm_sending';
          db.prepare(
            'UPDATE channel_actions SET status=?,updated_at=? WHERE channel=? AND account_id=? AND comment_id=? AND user_id=?',
          ).run(stage, now(), channel, row.account_id, row.comment_id, config.ownerId);
          job = { ...row, status: stage };
          break;
        }
        db.exec('COMMIT');
        return job;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    complete(job, providerId) {
      const publicPhase = job.status === 'public_sending';
      if (publicPhase)
        db.prepare(
          `UPDATE channel_actions SET status='public_done',public_id=?,last_error=NULL,updated_at=? WHERE channel=? AND user_id=? AND account_id=? AND comment_id=? AND status='public_sending'`,
        ).run(providerId, now(), channel, job.user_id, job.account_id, job.comment_id);
      else
        db.prepare(
          `UPDATE channel_actions SET status='sent',message_id=?,last_error=NULL,updated_at=? WHERE channel=? AND user_id=? AND account_id=? AND comment_id=? AND status='dm_sending'`,
        ).run(providerId, now(), channel, job.user_id, job.account_id, job.comment_id);
    },
    fail(job, uncertain, reason) {
      const status =
        (job.status === 'public_sending' ? 'public_' : 'dm_') + (uncertain ? 'unknown' : 'failed');
      db.prepare(
        'UPDATE channel_actions SET status=?,last_error=?,updated_at=? WHERE channel=? AND user_id=? AND account_id=? AND comment_id=? AND status=?',
      ).run(
        status,
        reason,
        now(),
        channel,
        job.user_id,
        job.account_id,
        job.comment_id,
        job.status,
      );
    },
    report(userId) {
      return {
        rules: db
          .prepare(
            `SELECT ${ruleFields} FROM channel_rules WHERE channel=? AND user_id=? ORDER BY enabled_at DESC`,
          )
          .all(channel, userId),
        actions: db
          .prepare(
            `SELECT ${actionFields} FROM channel_actions WHERE channel=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20`,
          )
          .all(channel, userId),
      };
    },
    close() {
      connection.release();
    },
  };
  return api;
}
