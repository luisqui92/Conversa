import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store.mjs';
import { makeServer } from './server.mjs';
import { createSaveQueue } from '../dist/session.mjs';

const origin = 'https://cc.chatgo.ia.bo';
function client(server, cookie = '') {
  return async (method, path, value, headers = {}) => new Promise(resolve => {
    const req = Readable.from(value === undefined ? [] : [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);
    Object.assign(req, { method, url: path, headers: { origin, 'content-type': 'application/json', cookie, ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const res = { headersSent: false, destroyed: false, writeHead(code, headers) { this.code = code; this.headers = headers; this.headersSent = true; }, end(text) { resolve({ status: this.code, headers: this.headers, body: JSON.parse(text) }); } };
    server.emit('request', req, res);
  });
}
test('Acceso, separación de usuarios, persistencia y protección del guardado', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'conversa-api-'));
  const path = join(dir, 'state.sqlite');
  let now = Date.now();
  let store = openStore(path, { now: () => now });
  const password = 'test-only-' + randomUUID();
  store.setPassword('a@example.test', password, true);
  store.setPassword('b@example.test', password, true);
  const server = makeServer({ store });
  const anonymous = client(server);
  async function login(email = 'a@example.test') {
    const result = await anonymous('POST', '/api/login', { email, password });
    assert.equal(result.status, 200);
    const cookie = result.headers['Set-Cookie'].split(';')[0];
    return { user: result.body.user, request: client(server, cookie), cookie };
  }
  try {
    await t.test('Rechaza acceso anónimo y operaciones desde otros sitios', async () => {
      assert.equal((await anonymous('GET', '/api/state')).status, 401);
      assert.equal((await anonymous('POST', '/api/login', {}, { origin: 'https://otro.example' })).status, 403);
      assert.equal((await anonymous('POST', '/api/login', {}, { origin: undefined })).status, 403);
      assert.equal((await anonymous('POST', '/api/login', {}, { 'content-type': 'text/plain' })).status, 415);
    });
    await t.test('Credenciales inválidas dan un mensaje genérico y cookie segura al entrar', async () => {
      const bad = await anonymous('POST', '/api/login', { email: 'a@example.test', password: 'incorrecta' });
      const missing = await anonymous('POST', '/api/login', { email: 'nadie@example.test', password: 'incorrecta' });
      assert.equal(bad.status, 401); assert.deepEqual(bad.body, missing.body);
      const ok = await anonymous('POST', '/api/login', { email: 'a@example.test', password });
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(ok.headers['Set-Cookie'].includes(flag));
      assert.ok(!JSON.stringify(ok.body).includes(password));
    });
    const a = await login(), b = await login('b@example.test');
    await t.test('Cada usuario solo lee y cambia su estado, aunque envíe identificadores ajenos', async () => {
      const initial = await a.request('GET', '/api/state');
      const state = initial.body.state;
      state.workspaces[state.current].label = 'Privado de A';
      state.userId = b.user.id;
      assert.equal((await a.request('PUT', '/api/state', state, { 'if-match': `"${initial.body.revision}"` })).status, 200);
      const ownB = await b.request('GET', '/api/state?userId=' + a.user.id);
      assert.notEqual(ownB.body.state.workspaces[ownB.body.state.current].label, 'Privado de A');
      assert.equal((await a.request('GET', '/api/state')).body.state.workspaces[state.current].label, 'Privado de A');
    });
    await t.test('Una pestaña antigua no sobrescribe datos nuevos', async () => {
      const first = (await a.request('GET', '/api/state')).body;
      const newer = structuredClone(first.state);
      newer.workspaces[newer.current].label = 'Cambio reciente';
      assert.equal((await a.request('PUT', '/api/state', newer, { 'if-match': `"${first.revision}"` })).status, 200);
      assert.equal((await a.request('PUT', '/api/state', first.state, { 'if-match': `"${first.revision}"` })).status, 409);
      assert.equal((await a.request('GET', '/api/state')).body.state.workspaces[newer.current].label, 'Cambio reciente');
      assert.equal((await a.request('PUT', '/api/state', newer)).status, 428);
    });
    await t.test('Rechaza estado inválido, enlaces ejecutables y cargas demasiado grandes', async () => {
      const current = (await a.request('GET', '/api/state')).body;
      const headers = { 'if-match': `"${current.revision}"` };
      assert.equal((await a.request('PUT', '/api/state', { version: 1 }, headers)).status, 422);
      current.state.workspaces[current.state.current].campaigns[0].bookingUrl = 'javascript:alert(1)';
      assert.equal((await a.request('PUT', '/api/state', current.state, headers)).status, 422);
      assert.equal((await a.request('PUT', '/api/state', 'x'.repeat(2 * 1024 * 1024 + 1), headers)).status, 413);
    });
    await t.test('No almacena contraseñas ni tokens de sesión en texto plano', async () => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const user = db.prepare('SELECT * FROM users WHERE email=?').get('a@example.test');
        assert.notEqual(user.password_hash, password);
        assert.equal(user.password_hash.length, 128);
        const rawToken = a.cookie.split('=')[1];
        assert.equal(db.prepare('SELECT count(*) AS count FROM sessions WHERE hash=?').get(rawToken).count, 0);
      } finally { db.close(); }
    });
    await t.test('Cerrar sesión invalida el acceso y cambiar contraseña revoca sesiones', async () => {
      assert.equal((await a.request('POST', '/api/logout', {})).status, 200);
      assert.equal((await a.request('GET', '/api/state')).status, 401);
      store.setPassword('b@example.test', 'test-replacement-' + randomUUID());
      assert.equal((await b.request('GET', '/api/state')).status, 401);
    });
    await t.test('La sesión vence y los intentos fallidos quedan limitados', async () => {
      const fresh = await login();
      now += 13 * 60 * 60_000;
      assert.equal((await fresh.request('GET', '/api/session')).status, 401);
      for (let i = 0; i < 10; i++) assert.equal((await anonymous('POST', '/api/login', { email: 'blocked@example.test', password: 'incorrecta' })).status, 401);
      assert.equal((await anonymous('POST', '/api/login', { email: 'blocked@example.test', password: 'incorrecta' })).status, 429);
    });
    await t.test('Los datos sobreviven a reabrir la base de datos', () => {
      store.close(); store = openStore(path, { now: () => now });
      assert.equal(store.readState(a.user.id).state.workspaces.inmobiliaria.label, 'Cambio reciente');
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Cola del navegador: serializa, conserva pendientes y no fuerza conflictos', async () => {
  const sends = [], replies = [], states = [];
  const queue = createSaveQueue({ revision: 4, transport(payload, revision) { sends.push({ payload, revision }); return new Promise((resolve, reject) => replies.push({ resolve, reject })); }, status(...value) { states.push(value); } });
  queue.save({ value: 1 }); queue.save({ value: 2 }); queue.save({ value: 3 });
  assert.equal(sends.length, 1);
  replies.shift().resolve({ revision: 5 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends.length, 2); assert.equal(sends[1].revision, 5); assert.equal(JSON.parse(sends[1].payload).value, 3);
  replies.shift().reject(Object.assign(new Error('Conflicto'), { status: 409 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.hasUnsaved(), true);
  queue.retry(); assert.equal(sends.length, 2); assert.equal(states.at(-1)[1], 'error');
});
