import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

const migrations = new URL("../../migrations/", import.meta.url);

/**
 * A minimal D1 stand-in backed by in-memory SQLite with the real migrations,
 * so tests exercise the production SQL. Batches run in one transaction.
 */
export const makeTestDatabase = () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }

  const execute = (sql: string, values: SQLInputValue[]) => {
    const prepared = sqlite.prepare(sql);
    if (prepared.columns().length > 0) {
      const results = prepared.all(...values);
      return { results, meta: { changes: /^\s*(INSERT|UPDATE|DELETE)/iu.test(sql) ? results.length : 0 } };
    }
    return { results: [], meta: { changes: Number(prepared.run(...values).changes) } };
  };

  const statement = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...bindings: SQLInputValue[]) => statement(sql, bindings),
    run: async () => execute(sql, values),
    all: async () => execute(sql, values),
    first: async () => execute(sql, values).results[0] ?? null,
    execute: () => execute(sql, values),
  });

  const db = {
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

  return { sqlite, db };
};
