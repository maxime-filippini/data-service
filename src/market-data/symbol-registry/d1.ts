import { Effect, Layer } from "effect";

import {
  SymbolRegistry,
  SymbolRegistryError,
  type TrackedSymbol,
} from "$/market-data/symbol-registry";
import type { Dataset } from "$/market-data/schemas";

interface SymbolRow {
  readonly dataset: Dataset;
  readonly symbol: string;
  readonly provider: string;
  readonly enabled: number;
  readonly backfill_start_date: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const fromRow = (row: SymbolRow): TrackedSymbol => ({
  dataset: row.dataset,
  symbol: row.symbol,
  provider: row.provider,
  enabled: row.enabled === 1,
  backfillStartDate: row.backfill_start_date,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const query = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new SymbolRegistryError({ kind: "database", message: "Could not access the symbol registry" }),
  });

export const D1SymbolRegistryLive = (db: D1Database): Layer.Layer<SymbolRegistry> =>
  Layer.succeed(
    SymbolRegistry,
    SymbolRegistry.of({
      register: (input, now) =>
        query(() =>
          db
            .prepare(
              `INSERT INTO tracked_symbols
                 (dataset, symbol, provider, enabled, backfill_start_date, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (dataset, symbol) DO UPDATE SET
                 provider = excluded.provider,
                 enabled = excluded.enabled,
                 backfill_start_date = excluded.backfill_start_date,
                 updated_at = excluded.updated_at
               RETURNING *`,
            )
            .bind(
              input.dataset,
              input.symbol,
              input.provider,
              Number(input.enabled ?? true),
              input.backfillStartDate,
              now,
              now,
            )
            .first<SymbolRow>(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.fail(
                  new SymbolRegistryError({ kind: "database", message: "Could not register the symbol" }),
                )
              : Effect.succeed({ symbol: fromRow(row), created: row.created_at === now }),
          ),
        ),

      list: ({ dataset, enabled }) =>
        query(() =>
          db
            .prepare(
              `SELECT * FROM tracked_symbols
               WHERE (?1 IS NULL OR dataset = ?1) AND (?2 IS NULL OR enabled = ?2)
               ORDER BY dataset, symbol`,
            )
            .bind(dataset ?? null, enabled === undefined ? null : Number(enabled))
            .all<SymbolRow>(),
        ).pipe(Effect.map((result) => result.results.map(fromRow))),

      disable: (dataset, symbol, now) =>
        query(() =>
          db
            .prepare(
              `UPDATE tracked_symbols SET enabled = 0, updated_at = ?
               WHERE dataset = ? AND symbol = ?
               RETURNING *`,
            )
            .bind(now, dataset, symbol)
            .first<SymbolRow>(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.fail(
                  new SymbolRegistryError({ kind: "not_found", message: "The symbol is not registered" }),
                )
              : Effect.succeed(fromRow(row)),
          ),
        ),
    }),
  );
