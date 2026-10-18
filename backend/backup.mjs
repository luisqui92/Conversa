import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
const source = process.env.DATABASE_PATH || '/data/conversa.sqlite';
const directory = join(dirname(source), 'backups');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const destination = join(
  directory,
  `conversa-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
);
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  chmodSync(destination, 0o600);
  console.log(destination);
} finally {
  db.close();
}
