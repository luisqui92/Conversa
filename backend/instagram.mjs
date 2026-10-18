import { emitKeypressEvents, createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from './store.mjs';
import { inspectInstagramToken, readInstagram, writeInstagram } from './instagram-connection.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';

const command = process.argv[2];
if (!['setup', 'status'].includes(command)) {
  console.error('Uso: node backend/instagram.mjs setup|status');
  process.exit(2);
}
const database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
const path =
  process.env.INSTAGRAM_CONFIG_PATH || join(dirname(database), 'instagram.credentials.json');
const origin = process.env.APP_ORIGIN || 'https://cc.chatgo.ia.bo';
const store = openStore(database);
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
function secret(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let value = '';
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function keypress(text, key) {
      if (key?.ctrl && key.name === 'c') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        store.close();
        process.exit(130);
      }
      if (['return', 'enter'].includes(key?.name)) {
        process.stdin.off('keypress', keypress);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(value.trim());
      } else if (key?.name === 'backspace') value = value.slice(0, -1);
      else if (
        text &&
        !key?.ctrl &&
        !key?.meta &&
        !/[\x00-\x1f\x7f]/.test(text) &&
        value.length + text.length <= 8192
      )
        value += text;
    }
    process.stdin.on('keypress', keypress);
  });
}
try {
  if (command === 'status') {
    const config = readInstagram(path);
    if (!config) console.log('Instagram todavía no está configurado.');
    else {
      const automation = openInstagramAutomation(database);
      try {
        const report = automation.report(config.ownerId);
        const active = report.rules.filter(
          (rule) => rule.enabled && rule.account_id === config.accountId,
        ).length;
        console.log(
          `Cuenta: @${config.username}\nPropietario en Conversa: ${config.ownerEmail}\nValidada: ${config.checkedAt}\nEventos recibidos: ${store.instagramEventCount(config.ownerId)}\nReglas activas: ${active}\nModo: ${active ? 'Comentario público → DM (solo publicaciones configuradas).' : 'Recepción solamente.'}`,
        );
        for (const action of report.actions.slice(0, 5))
          console.log(
            `Comentario ${action.comment_id}: ${action.status}${action.last_error ? ' — ' + action.last_error : ''}`,
          );
      } finally {
        automation.close();
      }
    }
  } else {
    if (!process.stdin.isTTY)
      throw new Error(
        'Ejecuta en una terminal interactiva; las credenciales se introducen ocultas.',
      );
    const email = await ask('Correo con el que inicias sesión en Conversa: ');
    const user = store.userByEmail(email);
    if (!user)
      throw new Error(
        'No existe ese usuario de Conversa. Créalo primero con backend/admin.mjs create-user.',
      );
    const previous = readInstagram(path);
    if (
      previous &&
      (await ask('Ya existe una conexión piloto. Escribe REEMPLAZAR para actualizarla: ')) !==
        'REEMPLAZAR'
    )
      throw new Error('Conexión anterior conservada.');
    const accessToken = await secret('Token de acceso de Instagram (oculto): ');
    if (!accessToken || accessToken.length > 8192 || /\s/.test(accessToken))
      throw new Error('Formato de token no válido.');
    console.log('Comprobando la cuenta con Instagram…');
    const profile = await inspectInstagramToken(accessToken);
    console.log(`Instagram confirmó: @${profile.username} (${profile.accountId}).`);
    const appSecret = await secret(
      'Clave secreta de la app de Instagram, en Meta → API de Instagram (oculta): ',
    );
    if (!/^[a-fA-F0-9]{32}$/.test(appSecret))
      throw new Error(
        'Se esperaba la clave secreta de 32 caracteres hexadecimales de la app de Instagram.',
      );
    const config = {
      ...profile,
      ownerId: user.id,
      ownerEmail: user.email,
      accessToken,
      appSecret,
      verifyToken: previous?.verifyToken || randomBytes(32).toString('hex'),
      checkedAt: new Date().toISOString(),
    };
    writeInstagram(path, config);
    console.log('Credenciales guardadas en el volumen privado; no se requieren reinicios.');
    console.log(`URL de devolución de llamada: ${origin}/api/webhooks/instagram`);
    console.log(`Token de verificación: ${config.verifyToken}`);
    console.log(
      'Copia esos dos valores en el apartado de webhooks de Meta. No compartas esta salida.',
    );
    console.log(
      'El receptor registra eventos firmados. Los envíos requieren activar una regla con backend/instagram-rule.mjs.',
    );
  }
} catch (error) {
  // Do not print provider bodies, URLs, config contents or raw network exceptions.
  const known = /^(Conversa|Instagram|No existe|Formato|Se esperaba|Conexión|Ejecuta)/.test(
    error.message,
  );
  console.error(
    known
      ? error.message
      : 'No se pudo completar la conexión. Revisa la red, los permisos y vuelve a intentarlo.',
  );
  process.exitCode = 1;
} finally {
  store.close();
}
