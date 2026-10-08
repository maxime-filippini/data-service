import { Effect, Layer } from "effect";
import {
  SymbolRegistry,
  SymbolRegistryError,
  type SymbolConfiguration,
  type TrackedSymbol,
  type ListSymbols,
  type SymbolIdentity,
} from "$/market-data/symbol-registry";

interface SymbolRow {
  readonly symbol: string;
  readonly provider: string;
  readonly enabled: number;
  readonly backfill_start_date: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
}

const fromRow = (row: SymbolRow): TrackedSymbol => ({
  symbol: row.symbol,
  provider: row.provider,
  enabled: row.enabled === 1,
  backfillStartDate: row.backfill_start_date,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  disabledAt: row.disabled_at,
});

const databaseOperation = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new SymbolRegistryError({
        kind: "database",
        message: "Could not access the symbol registry",
      }),
  });

const register = Effect.fn("SymbolRegistry.register")(function* (
  database: D1Database,
  input: SymbolConfiguration,
  now: string,
) {
  // One transaction makes insert detection and the returned configuration atomic.
  const [insert, , read] = yield* databaseOperation(() =>
    database.batch<SymbolRow>([
      database
        .prepare(
          `
          INSERT INTO tracked_symbols
          (symbol, provider, enabled, backfill_start_date, created_at, updated_at, disabled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (symbol, provider) DO NOTHING
          `,
        )
        .bind(
          input.symbol,
          input.provider,
          Number(input.enabled),
          input.backfillStartDate,
          now,
          now,
          input.enabled ? null : now,
        ),

      database
        .prepare(
          `
          UPDATE tracked_symbols SET
          disabled_at = CASE WHEN ? = 1 THEN NULL WHEN enabled = 1 THEN ? ELSE disabled_at END,
          enabled = ?, backfill_start_date = ?, updated_at = ?
          WHERE 1 = 1
          AND symbol = ? 
          AND provider = ?
          AND (enabled != ? OR backfill_start_date != ?)
          `,
        )
        .bind(
          Number(input.enabled),
          now,
          Number(input.enabled),
          input.backfillStartDate,
          now,
          input.symbol,
          input.provider,
          Number(input.enabled),
          input.backfillStartDate,
        ),

      database
        .prepare(
          "SELECT * FROM tracked_symbols WHERE symbol = ? AND provider = ?",
        )
        .bind(input.symbol, input.provider),
    ]),
  );

  // The pair identifies exactly one registry entry.
  const row = read.results[0];

  // Insertion failed/symbol didn't exist in the DB
  if (row === undefined) {
    return yield* Effect.fail(
      new SymbolRegistryError({
        kind: "database",
        message: "Could not read the registered symbol",
      }),
    );
  }

  return { symbol: fromRow(row), created: insert.meta.changes === 1 };
});

const disable = Effect.fn("SymbolRegistry.disable")(function* (
  database: D1Database,
  identity: SymbolIdentity,
  now: string,
) {
  const [, read] = yield* databaseOperation(() =>
    database.batch<SymbolRow>([
      database
        .prepare(
          `
          UPDATE tracked_symbols 
          SET enabled = 0, disabled_at = ?, updated_at = ?
          WHERE 1 = 1
          AND symbol = ?
          AND provider = ?
          AND enabled = 1
          `,
        )
        .bind(now, now, identity.symbol, identity.provider),
      database
        .prepare(
          "SELECT * FROM tracked_symbols WHERE symbol = ? AND provider = ?",
        )
        .bind(identity.symbol, identity.provider),
    ]),
  );

  const row = read.results[0];

  if (row === undefined) {
    return yield* Effect.fail(
      new SymbolRegistryError({
        kind: "not_found",
        message: "The symbol/provider pair is not registered",
        symbol: identity.symbol,
      }),
    );
  }

  return fromRow(row);
});

const list = (database: D1Database, input: ListSymbols) =>
  databaseOperation(() =>
    database
      .prepare(
        `SELECT * FROM tracked_symbols WHERE (symbol, provider) > (?, ?)
    ${input.enabled === undefined ? "" : "AND enabled = ?"} ORDER BY symbol, provider LIMIT ?`,
      )
      .bind(
        input.after?.symbol ?? "",
        input.after?.provider ?? "",
        ...(input.enabled === undefined ? [] : [Number(input.enabled)]),
        input.limit,
      )
      .all<SymbolRow>(),
  ).pipe(Effect.map((result) => result.results.map(fromRow)));

export const D1SymbolRegistryLive = (
  database: D1Database,
): Layer.Layer<SymbolRegistry> =>
  Layer.succeed(
    SymbolRegistry,
    SymbolRegistry.of({
      register: (input, now) => register(database, input, now),
      disable: (identity, now) => disable(database, identity, now),
      list: (input) => list(database, input),
    }),
  );
