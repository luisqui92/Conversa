import { emitKeypressEvents, createInterface } from 'node:readline';
import { openStore, validEmail } from './store.mjs';

const [command, providedEmail] = process.argv.slice(2);
if (!['create-user', 'set-password'].includes(command)) {
  console.error('Uso: node backend/admin.mjs create-user|set-password correo@empresa.com');
  process.exit(2);
}
if (!process.stdin.isTTY) {
  console.error('Ejecuta en una terminal interactiva. La contraseña se introduce oculta, nunca como argumento.');
  process.exit(2);
}
const email = providedEmail || await new Promise(resolve => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Correo del usuario: ', value => { rl.close(); resolve(value.trim()); });
});
if (!validEmail(email)) { console.error('Introduce un correo válido.'); process.exit(2); }
function secret(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    let value = '';
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function keypress(text, key) {
      if (key?.ctrl && key.name === 'c') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      if (['return', 'enter'].includes(key?.name)) {
        process.stdin.off('keypress', keypress); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(value);
      } else if (key?.name === 'backspace') value = value.slice(0, -1);
      else if (text && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(text) && value.length < 256) value += text;
    }
    process.stdin.on('keypress', keypress);
  });
}
const password = await secret('Contraseña nueva (mínimo 10 caracteres; no se muestra): ');
const confirm = await secret('Repetir contraseña: ');
if (password !== confirm) { console.error('Las contraseñas no coinciden.'); process.exit(2); }
const store = openStore(process.env.DATABASE_PATH || '/data/conversa.sqlite');
try { store.setPassword(email, password, command === 'create-user'); console.log(command === 'create-user' ? 'Usuario creado.' : 'Contraseña actualizada y sesiones cerradas.'); }
catch (error) { console.error(error.message.includes('UNIQUE') ? 'El usuario ya existe. Usa set-password para cambiar su contraseña.' : error.message); process.exitCode = 1; }
finally { store.close(); }
