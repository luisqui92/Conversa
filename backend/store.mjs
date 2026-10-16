import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createState, isValidState } from '../dist/data.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
export function validServerState(value) {
  try {
    if (!isValidState(value) || Object.keys(value.workspaces).length > 100) return false;
    for (const workspace of Object.values(value.workspaces)) {
      if (workspace.campaigns.length > 1000 || workspace.events.length > 10000) return false;
      if (typeof workspace.label !== 'string' || !workspace.label.trim() || workspace.label.length > 100) return false;
      for (const url of [...workspace.campaigns.map(c => c.bookingUrl), workspace.measurement?.website]) {
        if (url && (typeof url !== 'string' || new URL(url).protocol !== 'https:')) return false;
      }
      if (workspace.measurement?.enabled) return false;
    }
    return true;
  } catch { return false; }
}

export function openStore(path, { now = Date.now } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS states (user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS instagram_events (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), received_at INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS instagram_events_owner_time ON instagram_events(user_id, received_at);
    CREATE TABLE IF NOT EXISTS facebook_events (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), received_at INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS facebook_events_owner_time ON facebook_events(user_id, received_at);`);
  const dummySalt = '00000000000000000000000000000000';
  const dummyHash = scryptSync('not-a-real-password', dummySalt, 64);
  function setPassword(email, password, create = false) {
    email = String(email).trim().toLowerCase();
    if (!validEmail(email) || typeof password !== 'string' || password.length < 10 || password.length > 256) throw new Error('Usa un correo válido y una contraseña de 10 a 256 caracteres.');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (create) {
        const id = randomUUID();
        db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, email, salt, hash);
        db.prepare('INSERT INTO states VALUES (?,0,?)').run(id, JSON.stringify(createState()));
      } else {
        const user = db.prepare('SELECT id FROM users WHERE email=?').get(email);
        if (!user) throw new Error('No existe ese usuario.');
        db.prepare('UPDATE users SET salt=?, password_hash=? WHERE id=?').run(salt, hash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function limited(key, maximum) {
    const row = db.prepare('SELECT count,until_at FROM login_limits WHERE key=?').get(key);
    return Boolean(row && row.until_at > now() && row.count >= maximum);
  }
  function failure(key) {
    db.prepare(`INSERT INTO login_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN until_at<=? THEN 1 ELSE count+1 END,
      until_at=CASE WHEN until_at<=? THEN excluded.until_at ELSE until_at END`).run(key, now() + 15 * 60_000, now(), now());
  }
  return {
    setPassword,
    userByEmail(email) {
      return db.prepare('SELECT id,email FROM users WHERE email=?').get(String(email).trim().toLowerCase()) || null;
    },
    instagramEventCount(userId) {
      return db.prepare('SELECT count(*) AS count FROM instagram_events WHERE user_id=? AND received_at>?').get(userId, now() - 7 * 86400_000).count;
    },
    facebookEventCount(userId) {
      return db.prepare('SELECT count(*) AS count FROM facebook_events WHERE user_id=? AND received_at>?').get(userId, now() - 7 * 86400_000).count;
    },
    recordFacebookEntries(userId, entries) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM facebook_events WHERE received_at<=?').run(now() - 7 * 86400_000);
        for (const entry of entries) {
          const body = JSON.stringify(entry);
          db.prepare('INSERT OR IGNORE INTO facebook_events VALUES (?,?,?,?)').run(digest(userId + ':' + body), userId, now(), body);
        }
        db.prepare('DELETE FROM facebook_events WHERE user_id=? AND hash NOT IN (SELECT hash FROM facebook_events WHERE user_id=? ORDER BY received_at DESC,rowid DESC LIMIT 2000)').run(userId, userId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    readFacebookEvents(userId) {
      return db.prepare('SELECT received_at,body FROM facebook_events WHERE user_id=? AND received_at>? ORDER BY received_at DESC,rowid DESC LIMIT 20')
        .all(userId, now() - 7 * 86400_000).map(row => ({ receivedAt: row.received_at, entry: JSON.parse(row.body) }));
    },
    recordInstagramEntries(userId, entries) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM instagram_events WHERE received_at<=?').run(now() - 7 * 86400_000);
        for (const entry of entries) {
          const body = JSON.stringify(entry);
          db.prepare('INSERT OR IGNORE INTO instagram_events VALUES (?,?,?,?)').run(digest(userId + ':' + body), userId, now(), body);
        }
        db.prepare('DELETE FROM instagram_events WHERE user_id=? AND hash NOT IN (SELECT hash FROM instagram_events WHERE user_id=? ORDER BY received_at DESC,rowid DESC LIMIT 2000)').run(userId, userId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    readInstagramEvents(userId) {
      return db.prepare('SELECT received_at,body FROM instagram_events WHERE user_id=? AND received_at>? ORDER BY received_at DESC,rowid DESC LIMIT 20')
        .all(userId, now() - 7 * 86400_000).map(row => ({ receivedAt: row.received_at, entry: JSON.parse(row.body) }));
    },
    login(email, password, ip) {
      email = String(email ?? '').trim().toLowerCase();
      const keys = [`ip:${ip}`, `email:${digest(email)}`];
      db.prepare('DELETE FROM login_limits WHERE until_at<=?').run(now());
      if (limited(keys[0], 50) || limited(keys[1], 10)) return { limited: true };
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const candidate = scryptSync(typeof password === 'string' && password.length <= 256 ? password : '', user?.salt ?? dummySalt, 64);
      const expected = user ? Buffer.from(user.password_hash, 'hex') : dummyHash;
      if (!timingSafeEqual(candidate, expected) || !user || typeof password !== 'string' || password.length > 256) {
        for (const key of keys) failure(key);
        return null;
      }
      db.prepare('DELETE FROM login_limits WHERE key=?').run(keys[1]);
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), user.id, now() + 12 * 60 * 60_000);
      return { token, user: { id: user.id, email: user.email } };
    },
    session(token) {
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
      const row = db.prepare(`SELECT users.id,users.email FROM sessions JOIN users ON users.id=sessions.user_id
        WHERE sessions.hash=? AND sessions.expires_at>?`).get(digest(token), now());
      return row ? { id: row.id, email: row.email } : null;
    },
    logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); },
    readState(userId) {
      const row = db.prepare('SELECT revision,body FROM states WHERE user_id=?').get(userId);
      return row ? { revision: row.revision, state: JSON.parse(row.body) } : null;
    },
    writeState(userId, revision, state) {
      if (!validServerState(state)) return { invalid: true };
      const result = db.prepare('UPDATE states SET revision=revision+1,body=? WHERE user_id=? AND revision=?').run(JSON.stringify(state), userId, revision);
      return result.changes === 1 ? { revision: revision + 1 } : { conflict: true };
    },
    close() { db.close(); }
  };
}
