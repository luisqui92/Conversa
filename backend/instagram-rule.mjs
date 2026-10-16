import { dirname, join } from 'node:path';
import { openStore } from './store.mjs';
import { readInstagram } from './instagram-connection.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';

const [command, mediaId, publicText, dmText] = process.argv.slice(2);
if (!['enable', 'disable', 'status'].includes(command)) {
  console.error('Uso: node backend/instagram-rule.mjs enable ID_PUBLICACION "RESPUESTA_PUBLICA" "MENSAJE_DM" | disable ID_PUBLICACION | status');
  process.exit(2);
}
const database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
const main = openStore(database);
const automation = openInstagramAutomation(database);
try {
  const config = readInstagram(process.env.INSTAGRAM_CONFIG_PATH || join(dirname(database), 'instagram.credentials.json'));
  if (!config) throw new Error('Configura primero Instagram con backend/instagram.mjs setup.');
  if (command === 'enable') {
    automation.enable(config, mediaId, publicText, dmText);
    console.log(`Activada para @${config.username}, publicación ${mediaId}.\nPrimero comentario: ${publicText}\nDespués DM: ${dmText}\nResponde a comentarios nuevos de otras cuentas, sin filtro de palabras. Límite del piloto: 30 comentarios/hora.\nLos comentarios ya almacenados no se procesan retroactivamente.`);
  } else if (command === 'disable') {
    if (!/^\d{5,30}$/.test(mediaId || '')) throw new Error('Indica un ID de publicación válido.');
    automation.disable(config, mediaId);
    console.log('Regla desactivada. Una solicitud que ya esté en curso puede terminar.');
  } else {
    const report = automation.report(config.ownerId);
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { automation.close(); main.close(); }
