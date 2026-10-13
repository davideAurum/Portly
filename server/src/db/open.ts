/**
 * SQLite access via `node:sqlite` (`DatabaseSync`) — no native modules.
 *
 * - `run/get/all/exec` over cached prepared statements; params are positional (`?`) arrays or
 *   named objects (`{id}` for `:id`/`@id`/`$id`). SQL uses prepared statements only — never
 *   interpolate request data into SQL.
 * - Rows are plain objects (node:sqlite returns null-prototype objects); BLOBs are `Buffer`s.
 * - `tx(fn)` runs `fn` in `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on throw). Nested calls use
 *   savepoints. `fn` must be synchronous.
 * - Pragmas: busy_timeout=5000 first (switching to WAL needs a lock another process may hold for a
 *   moment), then foreign_keys=ON, journal_mode=WAL, secure_delete=ON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementResultingChanges, type StatementSync } from 'node:sqlite';

export type SqlValue = null | number | bigint | string | Buffer | Uint8Array;
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;
export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Db {
  run(sql: string, params?: SqlParams): RunResult;
  get<T = Row>(sql: string, params?: SqlParams): T | undefined;
  all<T = Row>(sql: string, params?: SqlParams): T[];
  /** Executes one or more statements without parameters (DDL, pragmas). */
  exec(sql: string): void;
  /** Runs `fn` in a transaction (BEGIN IMMEDIATE / savepoint when nested). */
  tx<T>(fn: () => T): T;
  /** True while a transaction is open. */
  readonly inTransaction: boolean;
  /** File path, or ':memory:'. */
  readonly location: string;
  close(): void;
  /** Escape hatch for operations the wrapper does not cover (e.g. `VACUUM INTO`). */
  readonly raw: DatabaseSync;
}

const STATEMENT_CACHE_SIZE = 256;

/** Converts a node:sqlite row (null prototype, Uint8Array BLOBs) into a plain object. */
export function toPlainRow(row: unknown): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value;
  }
  return out;
}

function isNamed(params: SqlParams): params is Readonly<Record<string, SqlValue>> {
  return !Array.isArray(params);
}

export interface OpenDbOptions {
  /** Create the parent directory if missing (default true for file databases). */
  mkdir?: boolean;
}

export function openDb(location: string, options: OpenDbOptions = {}): Db {
  const memory = location === ':memory:';
  if (!memory && (options.mkdir ?? true)) fs.mkdirSync(path.dirname(location), { recursive: true });

  const raw = new DatabaseSync(location, { enableForeignKeyConstraints: true });
  // Before journal_mode: without a busy timeout, a lock held by another connection fails at once (SQLITE_BUSY).
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA secure_delete = ON');
  raw.exec('PRAGMA synchronous = NORMAL');
  // The WAL file is truncated back to this after checkpoints (it would otherwise keep its peak size).
  raw.exec('PRAGMA journal_size_limit = 8388608');

  const statements = new Map<string, StatementSync>();
  let savepointDepth = 0;
  let closed = false;

  const prepare = (sql: string): StatementSync => {
    const cached = statements.get(sql);
    if (cached) {
      // Refresh LRU position.
      statements.delete(sql);
      statements.set(sql, cached);
      return cached;
    }
    const stmt = raw.prepare(sql);
    statements.set(sql, stmt);
    if (statements.size > STATEMENT_CACHE_SIZE) {
      const oldest = statements.keys().next().value;
      if (oldest !== undefined) statements.delete(oldest);
    }
    return stmt;
  };

  /** Positional params spread as-is; a named-params object is passed as the single first argument. */
  const args = (params: SqlParams | undefined): unknown[] => {
    if (params === undefined) return [];
    return isNamed(params) ? [params] : [...params];
  };
  type Invoke<R> = (...a: unknown[]) => R;

  const db: Db = {
    run(sql, params) {
      const stmt = prepare(sql);
      const result = (stmt.run as Invoke<StatementResultingChanges>).apply(stmt, args(params));
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    get<T = Row>(sql: string, params?: SqlParams): T | undefined {
      const stmt = prepare(sql);
      const row = (stmt.get as Invoke<unknown>).apply(stmt, args(params));
      return row === undefined ? undefined : (toPlainRow(row) as T);
    },
    all<T = Row>(sql: string, params?: SqlParams): T[] {
      const stmt = prepare(sql);
      const rows = (stmt.all as Invoke<unknown[]>).apply(stmt, args(params));
      return rows.map((r) => toPlainRow(r) as T);
    },
    exec(sql) {
      raw.exec(sql);
    },
    tx<T>(fn: () => T): T {
      const nested = raw.isTransaction;
      const savepoint = nested ? `sp_${++savepointDepth}` : null;
      raw.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      try {
        const result = fn();
        if (result instanceof Promise) {
          // Swallow the orphaned promise's eventual rejection; the transaction is already rolled back.
          result.catch(() => {});
          throw new TypeError('db.tx(fn): fn must be synchronous (it returned a Promise)');
        }
        raw.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (err) {
        if (savepoint) {
          raw.exec(`ROLLBACK TO ${savepoint}`);
          raw.exec(`RELEASE ${savepoint}`);
        } else if (raw.isTransaction) {
          raw.exec('ROLLBACK');
        }
        throw err;
      } finally {
        if (savepoint) savepointDepth--;
      }
    },
    get inTransaction() {
      return raw.isTransaction;
    },
    location,
    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      raw.close();
    },
    raw,
  };
  return db;
}
