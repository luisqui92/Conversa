import { readSelectedAccount, writeSelectedAccount } from './legacy-account-access.mjs';
import { readInstagram, writeInstagram } from './instagram-connection.mjs';

export const facebookGraph = 'https://graph.facebook.com/v26.0';
export const readFacebook = (path) =>
  process.env.CHANNEL_ACCOUNTS === '1'
    ? readSelectedAccount('facebook', path)
    : readInstagram(path);
export const writeFacebook = (path, config) =>
  process.env.CHANNEL_ACCOUNTS === '1'
    ? writeSelectedAccount('facebook', path, config)
    : writeInstagram(path, config);
export function safeFacebookError(status, data) {
  const code = Number.isSafeInteger(data?.error?.code) ? data.error.code : null;
  const subcode = Number.isSafeInteger(data?.error?.error_subcode)
    ? data.error.error_subcode
    : null;
  return `Facebook HTTP ${status}${code !== null ? `; código ${code}` : ''}${subcode !== null ? `; subcódigo ${subcode}` : ''}. ${code === 190 ? 'Facebook rechazó la autorización. Renueva la conexión con un token de usuario nuevo.' : 'Revisa permisos y acceso a la página.'}`;
}
async function graph(path, token, options = {}, request = fetch) {
  let response;
  try {
    response = await request(`${facebookGraph}/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Facebook: no se pudo contactar con la API. Vuelve a intentarlo.');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Facebook devolvió una respuesta no válida.');
  }
  if (!response.ok || data?.error) throw new Error(safeFacebookError(response.status, data));
  return data;
}
export async function resolveFacebookPage(userToken, expectedId, request = fetch) {
  if (!/^\d{5,30}$/.test(expectedId)) throw new Error('Indica un ID de página válido.');
  const result = await graph(
    'me/accounts?fields=id,name,access_token,tasks&limit=100',
    userToken,
    {},
    request,
  );
  const page = Array.isArray(result.data)
    ? result.data.find((item) => String(item.id) === expectedId)
    : null;
  if (!page)
    throw new Error(
      'Facebook: esa página no aparece entre las primeras 100 páginas autorizadas por este token de usuario.',
    );
  if (
    !Array.isArray(page.tasks) ||
    !page.tasks.includes('MODERATE') ||
    !page.tasks.includes('MESSAGING')
  )
    throw new Error('Facebook: la página necesita tareas MODERATE y MESSAGING para esta prueba.');
  if (
    typeof page.access_token !== 'string' ||
    !page.access_token ||
    typeof page.name !== 'string' ||
    !page.name
  )
    throw new Error(
      'Facebook no devolvió un token de página válido. Revisa los permisos concedidos.',
    );
  const identity = await graph('me?fields=id,name', page.access_token, {}, request);
  if (String(identity.id) !== expectedId)
    throw new Error('Facebook: el token obtenido no corresponde a la página seleccionada.');
  return {
    accountId: expectedId,
    username: page.name,
    accessToken: page.access_token,
    tasks: page.tasks,
  };
}
export async function subscribeFacebookPage(config, request = fetch) {
  const result = await graph(
    `${config.accountId}/subscribed_apps`,
    config.accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        subscribed_fields: 'feed,messages,messaging_postbacks',
      }).toString(),
    },
    request,
  );
  if (result.success !== true) throw new Error('Facebook no confirmó la suscripción de la página.');
  return true;
}
