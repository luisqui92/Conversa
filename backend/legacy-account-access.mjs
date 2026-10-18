import { dirname, join } from 'node:path';
import { openChannelAccounts } from './channel-accounts.mjs';

function selected(registry, channel) {
  const selector = process.env.CONVERSA_ACCOUNT_ID;
  if (selector) {
    const account = registry.get(selector) || registry.lookup(channel, selector);
    if (!account || account.channel !== channel)
      throw new Error('Conversa: la cuenta seleccionada no está disponible.');
    return account;
  }
  const accounts = registry.all(channel);
  if (accounts.length > 1)
    throw new Error(
      'Conversa: hay varias cuentas. Indica CONVERSA_ACCOUNT_ID al ejecutar la herramienta.',
    );
  return accounts[0] || null;
}
export function readSelectedAccount(channel, path) {
  const registry = openChannelAccounts(
    process.env.DATABASE_PATH || join(dirname(path), 'conversa.sqlite'),
  );
  try {
    return selected(registry, channel);
  } finally {
    registry.close();
  }
}
export function writeSelectedAccount(channel, path, config) {
  const registry = openChannelAccounts(
    process.env.DATABASE_PATH || join(dirname(path), 'conversa.sqlite'),
  );
  try {
    return registry.put(channel, config, { expectedVersion: config.version ?? 0 });
  } finally {
    registry.close();
  }
}
