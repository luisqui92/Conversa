import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore } from './store.mjs';

export function makeServer({ store, origin = 'https://cc.chatgo.ia.bo' }) {
  const allowedOrigin = new URL(origin).origin;
  if (!allowedOrigin.startsWith('https://')) throw new Error('APP_ORIGIN debe usar HTTPS.');
  function send(res, code, value, headers = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(value));
  }
  function token(req) {
    return String(req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('__Host-conversa='))?.slice('__Host-conversa='.length);
  }
  function body(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0, rejected = false;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (rejected) return;
        if (size > limit) {
          rejected = true; chunks.length = 0;
          const error = new Error('El archivo supera el límite permitido.'); error.status = 413; reject(error);
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { const error = new Error('JSON no válido.'); error.status = 400; reject(error); }
      });
      req.on('error', reject);
    });
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, allowedOrigin).pathname;
      if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true });
      if (!['GET', 'POST', 'PUT'].includes(req.method)) return send(res, 405, { error: 'Método no permitido.' }, { Allow: 'GET, POST, PUT' });
      if (req.method !== 'GET') {
        if (req.headers.origin !== allowedOrigin) return send(res, 403, { error: 'Origen no autorizado.' });
        if (!String(req.headers['content-type']).toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Se requiere application/json.' });
      }
      if (req.method === 'POST' && path === '/api/login') {
        const input = await body(req, 4096);
        if (!input || typeof input !== 'object' || typeof input.email !== 'string' || typeof input.password !== 'string') return send(res, 400, { error: 'Introduce correo y contraseña.' });
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim();
        const result = store.login(input.email, input.password, ip);
        if (result?.limited) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' }, { 'Retry-After': '900' });
        if (!result) return send(res, 401, { error: 'Correo o contraseña incorrectos.' });
        store.logout(token(req));
        return send(res, 200, { user: result.user }, { 'Set-Cookie': `__Host-conversa=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` });
      }
      const user = store.session(token(req));
      if (!user) return send(res, 401, { error: 'Inicia sesión para continuar.' });
      if (req.method === 'GET' && path === '/api/session') return send(res, 200, { user });
      if (req.method === 'POST' && path === '/api/logout') {
        store.logout(token(req));
        return send(res, 200, { ok: true }, { 'Set-Cookie': '__Host-conversa=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
      }
      if (req.method === 'GET' && path === '/api/state') return send(res, 200, store.readState(user.id));
      if (req.method === 'PUT' && path === '/api/state') {
        const match = /^"(\d+)"$/.exec(String(req.headers['if-match'] || ''));
        if (!match || !Number.isSafeInteger(Number(match[1]))) return send(res, 428, { error: 'Falta la versión del guardado. Recarga la página.' });
        const state = await body(req, 2 * 1024 * 1024);
        const result = store.writeState(user.id, Number(match[1]), state);
        if (result.invalid) return send(res, 422, { error: 'Los datos no tienen un formato válido para el servidor.' });
        if (result.conflict) return send(res, 409, { error: 'Los datos cambiaron en otra pestaña. Exporta tus cambios y recarga antes de continuar.' });
        return send(res, 200, result);
      }
      return send(res, 404, { error: 'Ruta no disponible.' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 500, { error: error.status ? error.message : 'No se pudo completar la operación.' }, error.status === 413 ? { Connection: 'close' } : {});
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openStore(process.env.DATABASE_PATH || '/data/conversa.sqlite');
  const server = makeServer({ store, origin: process.env.APP_ORIGIN || 'https://cc.chatgo.ia.bo' });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Conversa API lista.'));
  process.on('SIGTERM', () => server.close(() => { store.close(); process.exit(0); }));
}
