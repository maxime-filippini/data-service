import assert from "node:assert/strict";
import test from "node:test";

import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "$/db/schema";

import { makeTestDatabase } from "./support/d1";

interface Column {
  readonly type: string;
  readonly nullable: boolean;
}

const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));

test("the Drizzle schema mirrors every column of the migrated tables", () => {
  const { sqlite } = makeTestDatabase();
  assert.ok(tables.length > 0);

  for (const table of tables) {
    const config = getTableConfig(table);
    const migrated = sqlite
      .prepare(`SELECT * FROM pragma_table_info(?)`)
      .all(config.name) as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    assert.ok(migrated.length > 0, `${config.name} is not a migrated table`);

    // SQLite lets a non-INTEGER primary key hold NULL unless it says NOT
    // NULL; Drizzle types primary keys as non-null, which is what we write.
    const columns = (rows: [string, Column][]) =>
      Object.fromEntries(rows.sort(([a], [b]) => a.localeCompare(b)));
    assert.deepEqual(
      columns(
        config.columns.map((column) => [
          column.name,
          {
            type: column.getSQLType().toUpperCase(),
            nullable: !column.notNull,
          },
        ]),
      ),
      columns(
        migrated.map((column) => [
          column.name,
          {
            type: column.type,
            nullable: column.notnull === 0 && column.pk === 0,
          },
        ]),
      ),
      `columns of ${config.name}`,
    );

    const primaryKey = [
      ...config.columns.filter((column) => column.primary),
      ...config.primaryKeys.flatMap((key) => key.columns),
    ].map((column) => column.name);
    assert.deepEqual(
      primaryKey,
      migrated
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
      `primary key of ${config.name}`,
    );
  }
});
