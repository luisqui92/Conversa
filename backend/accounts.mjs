import { randomBytes } from 'node:crypto';
import { openStore } from './store.mjs';
import { openChannelAccounts } from './channel-accounts.mjs';
import { hidden } from './terminal.mjs';
const [command, channelOrEmail, appId] = process.argv.slice(2);
const database = process.env.DATABASE_PATH || '/data/conversa.sqlite';
const store = openStore(database),
  registry = openChannelAccounts(database);
try {
  if (command === 'list') {
    for (const customer of registry.customers())
      for (const a of registry.list(customer.owner_id))
        console.log(`${a.id} | ${a.channel} | ${a.username} | ${customer.email}`);
  } else if (command === 'grant-admin') {
    const user = store.userByEmail(channelOrEmail);
    if (!user) throw new Error('Usuario no disponible. Crea primero el usuario.');
    registry.grantAdmin(user.id);
    console.log('Permiso de administración concedido. Vuelve a iniciar sesión para ver Clientes.');
  } else if (command === 'configure-app') {
    const channel = channelOrEmail;
    if (!['instagram', 'facebook'].includes(channel) || !/^\d{5,30}$/.test(appId || ''))
      throw new Error('Indica instagram|facebook y el ID de la aplicación.');
    const previous = registry.app(channel);
    if (previous && previous.appId !== appId && registry.all(channel).length)
      throw new Error(
        'Hay cuentas activas de otra aplicación. Conserva su configuración y revisa la migración antes de cambiarla.',
      );
    const appSecret = await hidden('Clave secreta de la aplicación (oculta): ');
    if (!/^[a-fA-F0-9]{32}$/.test(appSecret)) throw new Error('Formato de clave no válido.');
    const configId =
      channel === 'facebook'
        ? await hidden(
            'ID de configuración de Facebook Login for Business (opcional, Enter para omitir): ',
          )
        : '';
    if (configId && !/^\d{5,30}$/.test(configId))
      throw new Error('El ID de configuración debe ser numérico.');
    const verifyToken = previous?.verifyToken || randomBytes(32).toString('hex');
    registry.setApp(channel, appId, { appSecret, verifyToken, ...(configId ? { configId } : {}) });
    console.log('Configuración cifrada guardada.');
    console.log(
      `Callback de autorización: ${process.env.APP_ORIGIN || 'https://cc.chatgo.ia.bo'}/api/oauth/${channel}/callback`,
    );
    console.log(
      `Webhook: ${process.env.APP_ORIGIN || 'https://cc.chatgo.ia.bo'}/api/webhooks/${channel}`,
    );
    if (!previous)
      console.log(
        'Verificador del webhook (copia a Meta; no compartas esta salida): ' + verifyToken,
      );
  } else
    throw new Error(
      'Uso: node backend/accounts.mjs list | grant-admin CORREO | configure-app instagram|facebook ID_APP',
    );
} catch (error) {
  console.error(
    /^(Uso:|Usuario|Indica|Hay cuentas|Formato|El ID|Ejecuta)/.test(error.message)
      ? error.message
      : 'No se pudo completar la operación. Revisa la configuración y la llave de cifrado.',
  );
  process.exitCode = 1;
} finally {
  registry.close();
  store.close();
}
