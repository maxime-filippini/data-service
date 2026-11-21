import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

const migrations = new URL("../../migrations/", import.meta.url);

const migrationPrefix = (filename: string) =>
  filename.split("_", 1)[0] ?? filename;

/** Migration SQL filenames in application order. */
export const listMigrationFiles = (): readonly string[] =>
  readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort();

/**
 * Apply repository SQL migrations to an open SQLite database. Pass `from`
 * and/or `through` numeric prefixes (e.g. `"0007"`, `"0008"`) to apply a
 * subset when rehearsing upgrades from an earlier production schema.
 */
export const applyMigrations = (
  sqlite: DatabaseSync,
  options: { readonly from?: string; readonly through?: string } = {},
): readonly string[] => {
  const applied: string[] = [];
  for (const file of listMigrationFiles()) {
    const prefix = migrationPrefix(file);
    if (options.from !== undefined && prefix < options.from) continue;
    if (options.through !== undefined && prefix > options.through) continue;
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
    applied.push(file);
  }
  return applied;
};

/**
 * Wrap an open SQLite database in the minimal D1 interface used by the
 * service. Batches run in a single transaction.
 */
export const wrapSqliteAsD1 = (sqlite: DatabaseSync): D1Database => {
  const execute = (sql: string, values: SQLInputValue[]) => {
    const prepared = sqlite.prepare(sql);
    if (prepared.columns().length > 0) {
      const results = prepared.all(...values);
      return {
        results,
        meta: {
          changes: /^\s*(INSERT|UPDATE|DELETE)/iu.test(sql)
            ? results.length
            : 0,
        },
      };
    }
    return {
      results: [],
      meta: { changes: Number(prepared.run(...values).changes) },
    };
  };

  const statement = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...bindings: SQLInputValue[]) => statement(sql, bindings),
    run: async () => execute(sql, values),
    all: async () => execute(sql, values),
    first: async () => execute(sql, values).results[0] ?? null,
    execute: () => execute(sql, values),
  });

  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((query) => query.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
};

/**
 * Open an existing SQLite database file as D1 without applying migrations.
 * Enables foreign-key enforcement to match Cloudflare D1.
 */
export const openSqliteD1 = (path: string) => {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  return { sqlite, db: wrapSqliteAsD1(sqlite) };
};

/**
 * A minimal D1 stand-in backed by SQLite with the real migrations, so tests
 * and the local fixture command exercise the production SQL. Batches run in
 * one transaction. In memory by default; pass a path for a database file you
 * can open afterwards.
 */
export const makeSqliteD1 = (
  path = ":memory:",
  options: { readonly through?: string } = {},
) => {
  const sqlite = new DatabaseSync(path);
  applyMigrations(sqlite, options);
  return { sqlite, db: wrapSqliteAsD1(sqlite) };
};
