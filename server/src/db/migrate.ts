/**
 * Schema migrations (§5). SQL files named `NNN_description.sql` are collected from
 * `db/migrations/` and every `modules/<name>/migrations/` folder, applied in filename order inside
 * one transaction, and tracked in `schema_migrations(name TEXT PK, applied_at)`.
 * A number is used once across all folders (a duplicate fails start-up in `listMigrations`);
 * a new migration takes the next free number.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../lib/logger.ts';
import type { Db } from './open.ts';

export const MIGRATION_NAME_REGEX = /^(\d{3})_[a-z0-9_]+\.sql$/;

const SERVER_SRC_DIR = path.resolve(import.meta.dirname, '..');

export interface MigrationFile {
  /** File name, e.g. `001_init.sql` (the tracking key). */
  name: string;
  number: number;
  file: string;
}

/** Default migration directories: `db/migrations` plus `modules/<module>/migrations`. */
export function defaultMigrationDirs(): string[] {
  const dirs = [path.join(SERVER_SRC_DIR, 'db', 'migrations')];
  const modulesDir = path.join(SERVER_SRC_DIR, 'modules');
  if (fs.existsSync(modulesDir)) {
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(modulesDir, entry.name, 'migrations');
      if (fs.existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/** Lists migration files from `dirs`, sorted by name; throws on bad names or duplicates. */
export function listMigrations(dirs: readonly string[] = defaultMigrationDirs()): MigrationFile[] {
  const byName = new Map<string, MigrationFile>();
  const byNumber = new Map<number, MigrationFile>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
      const match = MIGRATION_NAME_REGEX.exec(entry.name);
      if (!match) throw new Error(`Invalid migration file name "${entry.name}" in ${dir} (expected NNN_name.sql)`);
      const migration: MigrationFile = { name: entry.name, number: Number(match[1]), file: path.join(dir, entry.name) };
      const clash = byName.get(entry.name) ?? byNumber.get(migration.number);
      if (clash) throw new Error(`Duplicate migration number/name: ${clash.file} and ${migration.file}`);
      byName.set(entry.name, migration);
      byNumber.set(migration.number, migration);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface MigrateOptions {
  dirs?: readonly string[];
  log?: Logger;
  now?: () => number;
}

/** Applies pending migrations; returns the names applied (in order). */
export function migrate(db: Db, options: MigrateOptions = {}): string[] {
  const now = options.now ?? Date.now;
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  const applied = new Set(db.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
  const all = listMigrations(options.dirs);
  const known = new Set(all.map((m) => m.name));
  for (const name of applied) {
    if (!known.has(name)) options.log?.warn('applied migration missing on disk', { migration: name });
  }

  const pending = all.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return [];

  db.tx(() => {
    for (const m of pending) {
      const sql = fs.readFileSync(m.file, 'utf8');
      try {
        db.exec(sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${m.name} failed: ${message}`, { cause: err });
      }
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [m.name, now()]);
    }
  });
  for (const m of pending) options.log?.info('migration applied', { migration: m.name });
  return pending.map((m) => m.name);
}
