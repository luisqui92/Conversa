import { randomBytes, scryptSync } from 'node:crypto';
import { digest, validEmail } from './store.mjs';

const lifetime = 24 * 60 * 60_000;
const unavailable = () =>
  Object.assign(new Error('Invitación inválida o vencida. Solicita un enlace nuevo.'), {
    status: 410,
  });
export function createInvitations({ store, registry, origin, now = Date.now }) {
  const db = store.database;
  db.exec(`CREATE TABLE IF NOT EXISTS customer_invitations (
    user_id TEXT PRIMARY KEY REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS invitation_limits (ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until_at INTEGER NOT NULL);`);
  const fresh = () => ({ token: randomBytes(32).toString('hex'), expiresAt: now() + lifetime });
  const publicLink = (value) => ({
    url: new URL('/activar/', origin).href + '#' + value.token,
    expiresAt: value.expiresAt,
  });
  function record(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw unavailable();
    const row = db
      .prepare(
        `SELECT i.*,u.email,b.name FROM customer_invitations i
      JOIN users u ON u.id=i.user_id JOIN businesses b ON b.owner_id=u.id
      WHERE token_hash=? AND used_at IS NULL AND expires_at>?`,
      )
      .get(digest(token), now());
    if (!row) throw unavailable();
    return row;
  }
  return {
    create(input, adminId) {
      if (!registry.isAdmin(adminId))
        throw Object.assign(new Error('Acceso reservado al administrador.'), { status: 403 });
      if (
        !input ||
        Object.hasOwn(input, 'password') ||
        !validEmail(input.email) ||
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.length > 100
      )
        throw Object.assign(
          new Error(
            'Indica el negocio y correo. El cliente elegirá su contraseña mediante la invitación.',
          ),
          { status: 422 },
        );
      const invitation = fresh();
      const user = store.setPassword(input.email, randomBytes(32).toString('hex'), true, (user) => {
        registry.business(user.id, input.name.trim());
        db.prepare('INSERT INTO customer_invitations VALUES (?,?,?,?,NULL)').run(
          user.id,
          digest(invitation.token),
          adminId,
          invitation.expiresAt,
        );
      });
      return { user, business: registry.business(user.id), invitation: publicLink(invitation) };
    },
    reissue(userId, adminId) {
      if (!registry.isAdmin(adminId))
        throw Object.assign(new Error('Acceso reservado al administrador.'), { status: 403 });
      const invitation = fresh();
      const result = db
        .prepare(
          `UPDATE customer_invitations SET token_hash=?,created_by=?,expires_at=?
        WHERE user_id=? AND used_at IS NULL`,
        )
        .run(digest(invitation.token), adminId, invitation.expiresAt, userId);
      if (!result.changes)
        throw Object.assign(new Error('Ese acceso no tiene una invitación pendiente.'), {
          status: 409,
        });
      return { invitation: publicLink(invitation) };
    },
    customers() {
      return registry.customers().map((customer) => {
        const invite = db
          .prepare('SELECT expires_at,used_at FROM customer_invitations WHERE user_id=?')
          .get(customer.owner_id);
        return {
          ...customer,
          invitationPending: !!invite && invite.used_at === null,
          invitationExpiresAt: invite?.expires_at ?? null,
        };
      });
    },
    inspect(token) {
      const row = record(token);
      return { email: row.email, business: row.name, expiresAt: row.expires_at };
    },
    accept(token, password) {
      record(token);
      if (typeof password !== 'string' || password.length < 12 || password.length > 256)
        throw Object.assign(new Error('Elige una contraseña de 12 a 256 caracteres.'), {
          status: 422,
        });
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = record(token),
          salt = randomBytes(16).toString('hex');
        const hash = scryptSync(password, salt, 64).toString('hex');
        db.prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?').run(
          salt,
          hash,
          row.user_id,
        );
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
        db.prepare('UPDATE customer_invitations SET used_at=? WHERE user_id=?').run(
          now(),
          row.user_id,
        );
        db.exec('COMMIT');
        return { activated: true };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    allow(ip) {
      db.prepare('DELETE FROM invitation_limits WHERE until_at<=?').run(now());
      const key = digest(String(ip));
      db.prepare(
        `INSERT INTO invitation_limits VALUES (?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=attempts+1`,
      ).run(key, now() + 15 * 60_000);
      return (
        db.prepare('SELECT attempts FROM invitation_limits WHERE ip_hash=?').get(key).attempts <= 60
      );
    },
  };
}
