import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { migrations as allMigrations, type Migration } from './migrations/index.js';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  logger?: Logger;
  readonly?: boolean;
  migrations?: Migration[];
}

/**
 * Open (creating if needed) the SQLite database in WAL mode and apply pending migrations.
 * WAL lets the CLI read while the service writes; synchronous=NORMAL is durable enough in WAL
 * (a power cut can lose the last transaction, never corrupt the file).
 */
export function openDatabase(file: string, opts: OpenDatabaseOptions = {}): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  db.pragma('busy_timeout = 5000');
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    migrate(db, opts.migrations ?? allMigrations, opts.logger);
  }
  return db;
}

export function migrate(db: Db, migrations: Migration[], logger?: Logger): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const versionOf = (): number =>
    (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  let applied = 0;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= versionOf()) continue;
    // IMMEDIATE takes the write lock first and we re-check inside it, so the service and a CLI
    // command opening the database at the same moment can't both apply the same migration.
    const didApply = db
      .transaction(() => {
        if (m.version <= versionOf()) return false;
        db.exec(m.sql);
        record.run(m.version, m.name, Date.now());
        return true;
      })
      .immediate();
    if (didApply) {
      applied++;
      logger?.info({ version: m.version, name: m.name }, 'Applied database migration');
    }
  }
  return applied;
}

export function schemaVersion(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
}
