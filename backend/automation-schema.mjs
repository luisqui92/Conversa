import { installNotifications } from './notifications.mjs';

export function installAutomation(db) {
  installNotifications(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS channel_rules (
      channel TEXT NOT NULL,account_id TEXT NOT NULL,media_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),public_text TEXT NOT NULL,dm_text TEXT NOT NULL,
      enabled INTEGER NOT NULL,enabled_at INTEGER NOT NULL,keywords TEXT NOT NULL DEFAULT '[]',cooldown_seconds INTEGER NOT NULL DEFAULT 86400,
      PRIMARY KEY(channel,account_id,media_id));
      CREATE TABLE IF NOT EXISTS channel_actions (
      channel TEXT NOT NULL,account_id TEXT NOT NULL,comment_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
      media_id TEXT NOT NULL,rule_enabled_at INTEGER NOT NULL,comment_at INTEGER NOT NULL,
      public_text TEXT NOT NULL,dm_text TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      public_id TEXT,message_id TEXT,last_error TEXT,author_id TEXT,
      PRIMARY KEY(channel,account_id,comment_id));
      CREATE INDEX IF NOT EXISTS channel_actions_queue ON channel_actions(channel,account_id,user_id,status,created_at);
      CREATE INDEX IF NOT EXISTS channel_actions_person ON channel_actions(channel,account_id,media_id,author_id,created_at);
      CREATE INDEX IF NOT EXISTS channel_actions_owner ON channel_actions(user_id,created_at);
      CREATE INDEX IF NOT EXISTS channel_actions_retention ON channel_actions(updated_at);`);
    const rules = 'account_id,media_id,user_id,public_text,dm_text,enabled,enabled_at';
    const actions =
      'account_id,comment_id,user_id,media_id,rule_enabled_at,comment_at,public_text,dm_text,status,created_at,updated_at,public_id,message_id,last_error';
    // Identifiers below come exclusively from this fixed list. No SQL text rewriting.
    for (const channel of ['instagram', 'facebook']) {
      const oldRules = `${channel}_rules`,
        oldActions = `${channel}_actions`;
      db.exec(`DROP TRIGGER IF EXISTS ${channel}_notify_result`);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(oldRules)) {
        db.exec(
          `INSERT INTO channel_rules(channel,${rules}) SELECT '${channel}',${rules} FROM ${oldRules}; DROP TABLE ${oldRules};`,
        );
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(oldActions)) {
        db.exec(
          `INSERT INTO channel_actions(channel,${actions}) SELECT '${channel}',${actions} FROM ${oldActions}; DROP TABLE ${oldActions};`,
        );
      }
      db.exec(`CREATE VIEW IF NOT EXISTS ${oldRules} AS SELECT ${rules} FROM channel_rules WHERE channel='${channel}';
        CREATE VIEW IF NOT EXISTS ${oldActions} AS SELECT ${actions} FROM channel_actions WHERE channel='${channel}';`);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS channel_action_notification AFTER UPDATE OF status ON channel_actions
      WHEN OLD.status<>NEW.status AND ((NEW.status='sent' AND NEW.public_id IS NOT NULL AND NEW.message_id IS NOT NULL)
      OR NEW.status IN ('public_failed','dm_failed','public_unknown','dm_unknown'))
      BEGIN INSERT OR IGNORE INTO notifications(event_key,user_id,channel,account_id,comment_id,media_id,status,created_at)
      VALUES(NEW.channel||':'||NEW.account_id||':'||NEW.comment_id||':'||NEW.status,NEW.user_id,NEW.channel,NEW.account_id,NEW.comment_id,NEW.media_id,NEW.status,NEW.updated_at); END;
      CREATE TRIGGER IF NOT EXISTS channel_skip_notification AFTER INSERT ON channel_actions
      WHEN NEW.status IN ('skipped_rate_limit','skipped_late','skipped_author')
      BEGIN INSERT OR IGNORE INTO notifications(event_key,user_id,channel,account_id,comment_id,media_id,status,created_at)
      VALUES(NEW.channel||':'||NEW.account_id||':'||NEW.comment_id||':'||NEW.status,NEW.user_id,NEW.channel,NEW.account_id,NEW.comment_id,NEW.media_id,NEW.status,NEW.updated_at); END;`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
