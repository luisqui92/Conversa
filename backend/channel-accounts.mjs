import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from './database.mjs';

const channels = ['instagram', 'facebook'];
const numeric = (value) => typeof value === 'string' && /^\d{5,30}$/.test(value);
export const accountError = (message, status = 422) =>
  Object.assign(new Error(message), { status });
export function createMasterKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32)
    throw new Error(
      'La llave de cifrado no tiene el formato esperado. No se modificaron las credenciales.',
    );
  return key;
}
export function loadMasterKey(path) {
  try {
    const key = readFileSync(path);
    if (key.length === 32) return key;
  } catch {
    /* Fail closed. */
  }
  throw new Error(
    'Falta una llave de cifrado válida. Ejecuta la inicialización antes de iniciar Conversa.',
  );
}
export function seal(value, key, context) {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({
    v: 1,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  });
}
export function unseal(envelope, key, context) {
  try {
    const value = JSON.parse(envelope);
    if (value.v !== 1) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString(
        'utf8',
      ),
    );
  } catch {
    throw new Error(
      'No se pudo descifrar una credencial. Verifica la llave y restaura el respaldo si corresponde.',
    );
  }
}
export function openChannelAccounts(
  path,
  {
    key,
    keyPath = process.env.MASTER_KEY_PATH || '/run/conversa-keys/master.key',
    now = Date.now,
  } = {},
) {
  key ||= loadMasterKey(keyPath);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Llave de cifrado inválida.');
  const connection = openDatabase(path),
    db = connection.db;
  db.exec(`CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE REFERENCES users(id), name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS business_members (
      business_id TEXT NOT NULL REFERENCES businesses(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
      PRIMARY KEY(business_id,user_id));
    CREATE TABLE IF NOT EXISTS platform_admins (user_id TEXT PRIMARY KEY REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS channel_accounts (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), owner_id TEXT NOT NULL REFERENCES users(id),
      channel TEXT NOT NULL CHECK(channel IN ('instagram','facebook')), account_id TEXT NOT NULL,
      username TEXT NOT NULL, encrypted_config TEXT NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL,
      checked_at TEXT, expires_at INTEGER, data_expires_at INTEGER, updated_at INTEGER NOT NULL,
      UNIQUE(channel,account_id));
    CREATE INDEX IF NOT EXISTS channel_accounts_business ON channel_accounts(business_id,channel);
    CREATE TABLE IF NOT EXISTS provider_apps (channel TEXT PRIMARY KEY, app_id TEXT NOT NULL, encrypted_config TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS connection_jobs (
      account_id TEXT PRIMARY KEY REFERENCES channel_accounts(id),locked_until INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
      last_attempt INTEGER,last_error TEXT);
    CREATE TABLE IF NOT EXISTS connection_migrations (channel TEXT PRIMARY KEY, account_id TEXT NOT NULL, imported_at INTEGER NOT NULL);`);
  function business(userId, label) {
    const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(userId);
    if (!user) throw accountError('Usuario no disponible.', 404);
    let row = db.prepare('SELECT * FROM businesses WHERE owner_id=?').get(userId);
    if (!row) {
      const id = randomUUID();
      db.prepare('INSERT INTO businesses VALUES (?,?,?,?)').run(
        id,
        userId,
        String(label || 'Mi negocio').slice(0, 100),
        now(),
      );
      db.prepare('INSERT INTO business_members VALUES (?,?,?)').run(id, userId, 'owner');
      row = db.prepare('SELECT * FROM businesses WHERE id=?').get(id);
    }
    return row;
  }
  function decode(row) {
    if (!row) return null;
    const config = unseal(
      row.encrypted_config,
      key,
      `account:${row.id}:${row.business_id}:${row.owner_id}:${row.channel}:${row.account_id}`,
    );
    // Tenant and account bindings are authoritative database values, not decrypted caller input.
    return {
      ...config,
      id: row.id,
      businessId: row.business_id,
      channel: row.channel,
      accountId: row.account_id,
      ownerId: row.owner_id,
      username: row.username,
      version: row.version,
      enabled: Boolean(row.enabled),
    };
  }
  function metadata(row) {
    return {
      id: row.id,
      businessId: row.business_id,
      channel: row.channel,
      accountId: row.account_id,
      username: row.username,
      checkedAt: row.checked_at,
      expiresAt: row.expires_at,
      dataAccessExpiresAt: row.data_expires_at,
      enabled: Boolean(row.enabled),
      version: row.version,
    };
  }
  const api = {
    business,
    isAdmin(userId) {
      return Boolean(db.prepare('SELECT 1 FROM platform_admins WHERE user_id=?').get(userId));
    },
    grantAdmin(userId) {
      business(userId);
      db.prepare('INSERT OR IGNORE INTO platform_admins VALUES (?)').run(userId);
    },
    customers() {
      return db
        .prepare(
          `SELECT b.id,b.name,b.owner_id,u.email,(SELECT count(*) FROM channel_accounts a WHERE a.business_id=b.id) AS accounts
        FROM businesses b JOIN users u ON u.id=b.owner_id ORDER BY b.created_at DESC`,
        )
        .all();
    },
    list(userId) {
      const b = business(userId);
      return db
        .prepare('SELECT * FROM channel_accounts WHERE business_id=? ORDER BY channel,username,id')
        .all(b.id)
        .map(metadata);
    },
    all(channel) {
      return db
        .prepare('SELECT * FROM channel_accounts WHERE channel=? AND enabled=1 ORDER BY id')
        .all(channel)
        .map(decode);
    },
    get(id, userId = null) {
      const row = db.prepare('SELECT * FROM channel_accounts WHERE id=?').get(id);
      if (userId && row?.business_id !== business(userId).id) return null;
      return decode(row);
    },
    lookup(channel, accountId) {
      return decode(
        db
          .prepare('SELECT * FROM channel_accounts WHERE channel=? AND account_id=? AND enabled=1')
          .get(channel, accountId),
      );
    },
    put(channel, config, { expectedVersion, businessName } = {}) {
      if (
        !channels.includes(channel) ||
        !numeric(config.accountId) ||
        typeof config.username !== 'string' ||
        !config.username.trim() ||
        typeof config.accessToken !== 'string' ||
        !config.accessToken ||
        config.accessToken.length > 8192 ||
        /\s/.test(config.accessToken) ||
        typeof config.appSecret !== 'string' ||
        !config.appSecret ||
        !config.ownerId
      )
        throw accountError('Credenciales de canal incompletas.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const b = business(config.ownerId, businessName);
        const previous = db
          .prepare('SELECT * FROM channel_accounts WHERE channel=? AND account_id=?')
          .get(channel, config.accountId);
        if (previous && previous.business_id !== b.id)
          throw accountError('Esta cuenta social ya pertenece a otro negocio de Conversa.', 409);
        if (expectedVersion !== undefined && (previous?.version || 0) !== expectedVersion)
          throw accountError(
            'La conexión cambió durante la operación. Actualiza antes de continuar.',
            409,
          );
        const id = previous?.id || randomUUID(),
          version = (previous?.version || 0) + 1;
        const safeConfig = {
          ...config,
          appId: config.appId || api.app(channel)?.appId,
          verifyToken: config.verifyToken || randomBytes(32).toString('hex'),
        };
        delete safeConfig.userToken;
        const encrypted = seal(
          safeConfig,
          key,
          `account:${id}:${b.id}:${config.ownerId}:${channel}:${config.accountId}`,
        );
        db.prepare(
          `INSERT INTO channel_accounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET
          username=excluded.username,encrypted_config=excluded.encrypted_config,version=excluded.version,
          enabled=excluded.enabled,checked_at=excluded.checked_at,expires_at=excluded.expires_at,data_expires_at=excluded.data_expires_at,updated_at=excluded.updated_at`,
        ).run(
          id,
          b.id,
          config.ownerId,
          channel,
          config.accountId,
          config.username,
          encrypted,
          version,
          config.enabled === false ? 0 : 1,
          config.checkedAt || null,
          config.tokenInfo?.expiresAt ?? null,
          config.tokenInfo?.dataAccessExpiresAt ?? null,
          now(),
        );
        db.exec('COMMIT');
        return api.get(id);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    maintenanceClaim(id, lease = 120000) {
      db.prepare('INSERT OR IGNORE INTO connection_jobs(account_id) VALUES (?)').run(id);
      return (
        db
          .prepare(
            'UPDATE connection_jobs SET locked_until=?,last_attempt=? WHERE account_id=? AND locked_until<=? AND next_attempt<=?',
          )
          .run(now() + lease, now(), id, now(), now()).changes === 1
      );
    },
    maintenanceDone(id, { nextAttempt, error = null }) {
      db.prepare(
        'UPDATE connection_jobs SET locked_until=0,next_attempt=?,last_error=? WHERE account_id=?',
      ).run(nextAttempt, error, id);
    },
    maintenanceInfo(id) {
      return (
        db
          .prepare(
            'SELECT last_attempt,last_error,next_attempt FROM connection_jobs WHERE account_id=?',
          )
          .get(id) || null
      );
    },
    setApp(channel, appId, config) {
      if (
        !channels.includes(channel) ||
        !numeric(appId) ||
        !config.appSecret ||
        !config.verifyToken
      )
        throw accountError('Configuración de aplicación incompleta.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const encrypted = seal(config, key, `app:${channel}:${appId}`);
        db.prepare(
          `INSERT INTO provider_apps VALUES (?,?,?,?) ON CONFLICT(channel) DO UPDATE SET app_id=excluded.app_id,encrypted_config=excluded.encrypted_config,updated_at=excluded.updated_at`,
        ).run(channel, appId, encrypted, now());
        for (const row of db
          .prepare('SELECT * FROM channel_accounts WHERE channel=?')
          .all(channel)) {
          const account = decode(row);
          if (account.appId !== appId || account.appSecret === config.appSecret) continue;
          const updated = seal(
            { ...account, appSecret: config.appSecret },
            key,
            `account:${row.id}:${row.business_id}:${row.owner_id}:${channel}:${row.account_id}`,
          );
          db.prepare(
            'UPDATE channel_accounts SET encrypted_config=?,version=version+1,updated_at=? WHERE id=?',
          ).run(updated, now(), row.id);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    app(channel) {
      const row = db.prepare('SELECT * FROM provider_apps WHERE channel=?').get(channel);
      return row
        ? {
            ...unseal(row.encrypted_config, key, `app:${channel}:${row.app_id}`),
            appId: row.app_id,
            channel,
          }
        : null;
    },
    migrateLegacy(
      directory,
      {
        remove = false,
        instagramAppId = process.env.INSTAGRAM_APP_ID,
        facebookAppId = '39748148371443102',
      } = {},
    ) {
      const imported = [];
      for (const channel of channels) {
        const filename = join(directory, channel + '.credentials.json');
        let config;
        try {
          config = JSON.parse(readFileSync(filename, 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw new Error('No se pudo leer una conexión anterior; la migración se detuvo.');
        }
        const done = db.prepare('SELECT * FROM connection_migrations WHERE channel=?').get(channel);
        if (!done) {
          const appId = config.appId || (channel === 'facebook' ? facebookAppId : instagramAppId);
          config.appId = appId;
          const existing = api.lookup(channel, config.accountId);
          if (existing && existing.ownerId !== config.ownerId)
            throw accountError('La conexión anterior tiene otro propietario.', 409);
          if (!existing) api.put(channel, config);
          if (appId)
            api.setApp(channel, appId, {
              appSecret: config.appSecret,
              verifyToken: config.verifyToken,
            });
          db.prepare('INSERT INTO connection_migrations VALUES (?,?,?)').run(
            channel,
            config.accountId,
            now(),
          );
        }
        const stored = api.lookup(channel, config.accountId);
        if (!stored || stored.ownerId !== config.ownerId)
          throw new Error('No se confirmó la cuenta importada; se conserva el archivo anterior.');
        // A later legacy file must never overwrite an encrypted, renewed connection.
        imported.push({ channel, accountId: stored.accountId, ownerId: stored.ownerId });
      }
      const owners = new Set(imported.map((a) => a.ownerId));
      if (owners.size === 1 && !db.prepare('SELECT 1 FROM platform_admins LIMIT 1').get())
        api.grantAdmin([...owners][0]);
      if (remove)
        for (const item of imported)
          unlinkSync(join(directory, item.channel + '.credentials.json'));
      return imported;
    },
    close() {
      connection.release();
    },
  };
  return api;
}
