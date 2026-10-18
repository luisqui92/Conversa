import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databases = new Map();
export function openDatabase(path) {
  const key = resolve(path);
  let entry = databases.get(key);
  if (!entry) {
    mkdirSync(dirname(key), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(key);
    chmodSync(key, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    entry = { db, references: 0 };
    databases.set(key, entry);
  }
  entry.references++;
  let released = false;
  return {
    db: entry.db,
    release() {
      if (released) return;
      released = true;
      if (--entry.references === 0) {
        entry.db.close();
        databases.delete(key);
      }
    },
  };
}
