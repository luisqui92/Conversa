import { createInterface, emitKeypressEvents } from 'node:readline';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from './store.mjs';
import { resolveFacebookPage, readFacebook, writeFacebook, subscribeFacebookPage } from './facebook-connection.mjs';
import { openFacebookAutomation } from './facebook-automation.mjs';

const [command, pageOrPostId, publicText, dmText] = process.argv.slice(2);
if (!['setup','subscribe','status','enable','disable'].includes(command)) {
  console.error('Uso: node backend/facebook.mjs setup [ID_PAGINA] | subscribe | status | enable ID_POST "RESPUESTA" "MENSAJE_PRIVADO" | disable ID_POST'); process.exit(2);
}
const database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
const path = process.env.FACEBOOK_CONFIG_PATH || join(dirname(database), 'facebook.credentials.json');
const store = openStore(database);
const automation = openFacebookAutomation(database);
function ask(prompt) {
  return new Promise(resolve => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(prompt, value => { rl.close(); resolve(value.trim()); }); });
}
function secret(prompt) {
  return new Promise(resolve => {
    let value = ''; process.stdout.write(prompt);
    emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    function press(text, key) {
      if (key?.ctrl && key.name === 'c') { process.stdin.setRawMode(false); process.stdout.write('\n'); automation.close(); store.close(); process.exit(130); }
      if (['return','enter'].includes(key?.name)) { process.stdin.off('keypress',press); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(value.trim()); }
      else if (key?.name === 'backspace') value = value.slice(0,-1);
      else if (text && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(text) && value.length + text.length <= 8192) value += text;
    }
    process.stdin.on('keypress',press);
  });
}
try {
  const previous = readFacebook(path);
  if (command === 'setup') {
    if (!process.stdin.isTTY) throw new Error('Ejecuta setup en una terminal interactiva; los tokens se introducen ocultos.');
    const email = await ask('Correo con el que inicias sesión en Conversa: ');
    const user = store.userByEmail(email);
    if (!user) throw new Error('No existe ese usuario de Conversa. Crea primero el usuario.');
    const pageId = pageOrPostId || await ask('ID de la página de Facebook: ');
    if (!/^\d{5,30}$/.test(pageId)) throw new Error('Indica un ID de página válido.');
    if (previous && await ask('Ya existe una página conectada. Escribe REEMPLAZAR para actualizarla: ') !== 'REEMPLAZAR') throw new Error('Conexión anterior conservada.');
    const userToken = await secret('Token de USUARIO generado en el Explorador de Graph (oculto): ');
    if (!userToken || /\s/.test(userToken)) throw new Error('Formato de token no válido.');
    console.log('Obteniendo y comprobando el token de la página seleccionada…');
    const page = await resolveFacebookPage(userToken, pageId);
    console.log(`Facebook confirmó la página: ${page.username} (${page.accountId}).`);
    const appSecret = await secret('Clave secreta de Conversa → Configuración de la app → Básica (oculta; distinta de la clave de Instagram): ');
    if (!/^[a-fA-F0-9]{32}$/.test(appSecret)) throw new Error('Se esperaba la clave secreta de 32 caracteres hexadecimales de la app de Meta.');
    const config = { ...page, ownerId:user.id, ownerEmail:user.email, appSecret,
      verifyToken: previous?.verifyToken || randomBytes(32).toString('hex'), checkedAt:new Date().toISOString() };
    writeFacebook(path, config);
    console.log('Credenciales de Facebook guardadas. El token de usuario no se almacena.');
    console.log(`URL de devolución de llamada: ${process.env.APP_ORIGIN || 'https://cc.chatgo.ia.bo'}/api/webhooks/facebook`);
    console.log(`Token de verificación: ${config.verifyToken}`);
    console.log('Copia estos dos valores a los webhooks de Page/Facebook de la app Conversa. No reemplaces el webhook de Instagram.');
    console.log('Después de verificar y suscribir los campos en Meta, ejecuta: node backend/facebook.mjs subscribe');
  } else {
    if (!previous) throw new Error('Configura primero Facebook con backend/facebook.mjs setup.');
    if (command === 'subscribe') {
      await subscribeFacebookPage(previous);
      console.log(`Facebook confirmó la suscripción de ${previous.username} a feed, messages y messaging_postbacks. Verifica también el callback y los campos en Meta.`);
    } else if (command === 'enable') {
      automation.enable(previous, pageOrPostId, publicText, dmText);
      console.log(`Regla activada para ${previous.username}, publicación ${pageOrPostId}.\nPrimero comentario: ${publicText}\nDespués Messenger: ${dmText}\nSolo comentarios nuevos elegibles; sin procesamiento del historial. Piloto: máximo 30 comentarios/hora.`);
    } else if (command === 'disable') {
      if (!/^\d{5,30}(?:_\d{5,30}){0,2}$/.test(pageOrPostId || '')) throw new Error('Indica un ID de publicación válido.');
      automation.disable(previous,pageOrPostId); console.log('Regla desactivada. Una solicitud que ya esté en curso puede terminar.');
    } else {
      const report = automation.report(previous.ownerId);
      console.log(`Página: ${previous.username}\nID: ${previous.accountId}\nPropietario en Conversa: ${previous.ownerEmail}\nValidada: ${previous.checkedAt}\nEventos recibidos: ${store.facebookEventCount(previous.ownerId)}\nReglas activas: ${report.rules.filter(r => r.enabled && r.account_id === previous.accountId).length}`);
      for (const action of report.actions.slice(0,5)) console.log(`Comentario ${action.comment_id}: ${action.status}${action.last_error ? ' — ' + action.last_error : ''}`);
    }
  }
} catch (error) {
  const known = /^(Facebook|No existe|Formato|Indica|Se esperaba|Configura|Conexión|Ejecuta|Usa IDs)/.test(error.message);
  console.error(known ? error.message : 'No se pudo completar la operación de Facebook. Revisa la configuración y vuelve a intentarlo.'); process.exitCode=1;
} finally { automation.close(); store.close(); }
