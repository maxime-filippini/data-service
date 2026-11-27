# Type D1 queries with Drizzle over hand-written migrations

D1 adapters build their queries with Drizzle ORM's query builder
(`drizzle-orm/d1`) instead of SQL strings with hand-written row interfaces,
`fromRow` mappers and `.first<Row>()` or `results as Row[]` casts. Rows are
typed from table definitions in `src/db/schema.ts`. Assets is the reference
port; the other adapters move when they are next changed.

The SQL files in `migrations/` stay the source of truth, and
`wrangler d1 migrations` keeps applying them. `src/db/schema.ts` is a typed
mirror of the tables the ported adapters use, and `test/db-schema.test.ts`
checks it against the migrated database: every column's name, type and
nullability, and the primary key. A migration that renames, retypes, drops,
adds or relaxes a column fails the tests until the mirror follows it. drizzle-kit
does not generate migrations. It has no record of the fourteen existing ones,
so it would start from a new `CREATE TABLE` baseline, and owning the schema
would mean expressing every CHECK constraint, partial index and data backfill
(such as `0008`'s single-asset portfolios) in Drizzle as well.

Drizzle expresses what the assets adapter relies on: `NOT EXISTS` guards over
subqueries and `UNION ALL`, `INSERT ... SELECT` and
`INSERT ... ON CONFLICT DO NOTHING RETURNING`, scalar subqueries in a select,
and `orm.batch`, which sends one D1 batch and types each statement's result.
Partial unique indexes stay in the migrations and are only relied on, as
before. JSON columns such as `steps_json` stay `text` and are decoded with
Effect Schema. Drizzle's `mode: "json"` would only cast the parsed value.

Effect integration is the existing thin wrapper: Drizzle queries are promises,
so `d1Query(onFailure)(() => orm.select()...)` maps a rejection to the
adapter's expected error, as it did for `db.prepare`. During the migration a
Drizzle write can join a batch of plain D1 statements through
`toD1Statement(db, query)` in `src/d1.ts`. The portfolios adapter does this
with `assignDefaultsOnCreate`, which is now a Drizzle query.

The real-migration SQLite tests (`test/support/d1.ts`) are unchanged. The
SQLite stand-in gained `raw()`, which Drizzle uses to read typed rows as
column-ordered arrays.

## Measurements

Measured on the Worker bundle (`wrangler deploy --dry-run --minify`) with
`drizzle-orm` 0.45.4 and Effect 4.1.6:

| Bundle                | Size        | gzip       |
| --------------------- | ----------- | ---------- |
| Without Drizzle       | 992.74 KiB  | 317.31 KiB |
| With Drizzle (assets) | 1076.71 KiB | 339.90 KiB |
| Cost                  | +83.97 KiB  | +22.59 KiB |

Later ports reuse the same query builder and dialect, so the cost should grow
little with each one. `wrangler check startup` measured local startup CPU (five runs each)
at a median of 45.2 ms without Drizzle and 47.0 ms with it, a difference
within the run-to-run spread.

## Considered options

- **Kysely** (`kysely-d1`) types queries in a similar way, but its D1 dialect
  has no batch support. The adapters depend on batches for atomic, guarded
  multi-statement writes, so each one would compile its queries and batch them
  by hand, losing typed results. The dialect was last published in April 2025.
- **`@effect/sql-d1`** is Effect-native: a `SqlClient` service with typed
  `SqlError`s, batches and Schema-decoded rows. Its queries are still SQL
  template strings, so it catches a mismatch with the migrations when a query
  runs, not when it is compiled, and it is marked unstable.
- **Keep hand-written SQL.** Raw SQL remains easier to read for the longest
  guarded statements, but nothing ties those statements to the migrations.

## Consequences

- A batch rebuilds each row from D1's result objects by key order. Two selected
  columns with the same name (a join selecting `a.id` and `b.id`) collapse into
  one, so selects in a batch alias their columns uniquely. Queries outside a
  batch read arrays and are not affected.
- `update().set({...})` skips `undefined` fields, which replaces the
  `coalesce(?, column)` pattern for partial updates.
- Drizzle's transactions issue `BEGIN`, which D1 rejects; atomicity stays with
  `orm.batch`.
- Adding a table to `src/db/schema.ts` means declaring every column of it, so
  the drift check covers the whole table.
