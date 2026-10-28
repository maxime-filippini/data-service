import { Effect, Layer } from "effect";

import {
  SymbolRegistry,
  SymbolRegistryError,
  type TrackedSymbol,
} from "$/market-data/symbol-registry";
import type { Dataset } from "$/market-data/schemas";
import { SINGLE_ASSET_HOLDINGS_DATE } from "$/portfolios";

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
      // A new prices_eod symbol also gets its single-asset portfolio, in the
      // same batch. Re-registering leaves an existing one alone.
      register: (input, now) => {
        const portfolioId = crypto.randomUUID();
        return query(() =>
          db.batch([
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
              ),
            db
              .prepare(
                `INSERT INTO portfolios (portfolio_id, name, created_at, updated_at, asset_symbol)
                 SELECT ?1, ?2, ?3, ?3, ?2 WHERE ?4 = 'prices_eod'
                 ON CONFLICT DO NOTHING`,
              )
              .bind(portfolioId, input.symbol, now, input.dataset),
            // Only inserts when the portfolio above was created.
            db
              .prepare(
                `INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at)
                 SELECT portfolio_id, ?2, created_at FROM portfolios WHERE portfolio_id = ?1`,
              )
              .bind(portfolioId, SINGLE_ASSET_HOLDINGS_DATE),
            db
              .prepare(
                `INSERT INTO portfolio_holdings (portfolio_id, holdings_date, dataset, symbol, weight)
                 SELECT portfolio_id, ?2, 'prices_eod', asset_symbol, 1 FROM portfolios WHERE portfolio_id = ?1`,
              )
              .bind(portfolioId, SINGLE_ASSET_HOLDINGS_DATE),
          ]),
        ).pipe(
          Effect.flatMap(([upserted]) => {
            const row = (upserted?.results as SymbolRow[] | undefined)?.[0];
            return row === undefined
              ? Effect.fail(new SymbolRegistryError({ kind: "database", message: "Could not register the symbol" }))
              : Effect.succeed({ symbol: fromRow(row), created: row.created_at === now });
          }),
        );
      },

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

      get: (dataset, symbol) =>
        query(() =>
          db
            .prepare(`SELECT * FROM tracked_symbols WHERE dataset = ? AND symbol = ?`)
            .bind(dataset, symbol)
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

      setEnabled: (dataset, symbol, enabled, now) =>
        query(() =>
          db
            .prepare(
              `UPDATE tracked_symbols SET enabled = ?, updated_at = ?
               WHERE dataset = ? AND symbol = ?
               RETURNING *`,
            )
            .bind(Number(enabled), now, dataset, symbol)
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
