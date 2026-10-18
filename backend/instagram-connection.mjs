import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readSelectedAccount, writeSelectedAccount } from './legacy-account-access.mjs';

export const graphOrigin = 'https://graph.instagram.com/v24.0';
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
export function readInstagram(path) {
  if (process.env.CHANNEL_ACCOUNTS === '1') return readSelectedAccount('instagram', path);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export function writeInstagram(path, config) {
  if (process.env.CHANNEL_ACCOUNTS === '1') return writeSelectedAccount('instagram', path, config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
export function validSignature(raw, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  return equalSecret(signature, `sha256=${expected}`);
}
export async function inspectInstagramToken(accessToken, request = fetch) {
  // The credential is sent in the Authorization header, never in a URL or log.
  const response = await request(`${graphOrigin}/me?fields=user_id,username`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error('Instagram rechazó el token. Revisa su vigencia y los permisos de la cuenta.');
  const profile = await response.json();
  const accountId = String(profile.user_id || profile.id || '');
  if (!/^\d{5,30}$/.test(accountId) || typeof profile.username !== 'string' || !profile.username)
    throw new Error('Instagram no devolvió una cuenta profesional válida.');
  return { accountId, username: profile.username };
}
export function rawBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0,
      failed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (failed) return;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        const error = new Error('Webhook demasiado grande.');
        error.status = 413;
        reject(error);
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Solicitud interrumpida.')));
  });
}
