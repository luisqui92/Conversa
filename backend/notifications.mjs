export function installNotifications(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL,
    account_id TEXT NOT NULL, comment_id TEXT NOT NULL, media_id TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE INDEX IF NOT EXISTS notifications_time ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS notifications_owner_time ON notifications(user_id,created_at);
    CREATE INDEX IF NOT EXISTS notifications_owner_unread ON notifications(user_id,read_at,id);`);
}

// Scopes always come from the server's currently configured accounts, never the browser.
export function notificationQueries(db, now = Date.now) {
  function scope(userId, accounts) {
    const valid = accounts.filter(a => ['instagram', 'facebook'].includes(a.channel) && /^\d{5,30}$/.test(a.accountId));
    return { sql: `user_id=? AND created_at>? AND (${valid.map(() => '(channel=? AND account_id=?)').join(' OR ') || '0'})`,
      args: [userId, now() - 7 * 86400_000, ...valid.flatMap(a => [a.channel, a.accountId])] };
  }
  const fields = 'id,channel,account_id,comment_id,media_id,status,created_at,read_at';
  return {
    feed(userId, accounts) {
      db.prepare('DELETE FROM notifications WHERE created_at<=?').run(now() - 7 * 86400_000);
      const where = scope(userId, accounts);
      const counts = db.prepare(`SELECT count(CASE WHEN read_at IS NULL THEN 1 END) AS unread,coalesce(max(id),0) AS lastId FROM notifications WHERE ${where.sql}`).get(...where.args);
      return { ...counts, notifications: db.prepare(`SELECT ${fields} FROM notifications WHERE ${where.sql} ORDER BY id DESC LIMIT 30`).all(...where.args) };
    },
    detail(userId, accounts, id) {
      const where = scope(userId, accounts);
      return db.prepare(`SELECT ${fields} FROM notifications WHERE ${where.sql} AND id=?`).get(...where.args, id) || null;
    },
    markRead(userId, accounts, input) {
      const bad = () => Object.assign(new Error('Indica las notificaciones que quieres marcar como leídas.'), { status: 422 });
      const positive = id => Number.isSafeInteger(id) && id > 0;
      if (!input || typeof input !== 'object') throw bad();
      const idsMode = Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 100 && input.ids.every(positive) && input.throughId === undefined;
      const throughMode = positive(input.throughId) && input.ids === undefined;
      if (!idsMode && !throughMode) throw bad();
      const where = scope(userId, accounts);
      const target = idsMode ? `id IN (${input.ids.map(() => '?').join(',')})` : 'id<=?';
      return db.prepare(`UPDATE notifications SET read_at=? WHERE ${where.sql} AND read_at IS NULL AND ${target}`)
        .run(now(), ...where.args, ...(idsMode ? input.ids : [input.throughId])).changes;
    }
  };
}
