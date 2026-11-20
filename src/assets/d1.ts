import { Effect, Layer } from "effect";

import { d1Query } from "$/d1";
import { type Asset, AssetError } from "$/assets/contracts";
import { AssetStore } from "$/assets/store";
import { assignDefaultsOnCreate } from "$/workflows/d1";

/** Private `assets` row, converted to the `Asset` view by `fromRow`. */
interface AssetRow {
  readonly symbol: string;
  readonly provider: string;
  readonly backfill_start_date: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const fromRow = (row: AssetRow): Asset => ({
  symbol: row.symbol,
  provider: row.provider,
  backfillStartDate: row.backfill_start_date,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const query = d1Query(
  () =>
    new AssetError({ kind: "database", message: "Could not access assets" }),
);

const notFound = (symbol: string) =>
  new AssetError({
    kind: "not_found",
    message: `The asset ${symbol} does not exist`,
  });

const found = (symbol: string) => (row: AssetRow | null | undefined) =>
  row == null ? Effect.fail(notFound(symbol)) : Effect.succeed(fromRow(row));

/** An active workflow run (alias `r`) for the asset ?1. */
const ACTIVE_RUN_FOR_ASSET = `FROM workflow_runs r
  WHERE r.subject_kind = 'asset' AND r.subject_id = ?1
    AND r.status IN ('queued', 'running', 'waiting')`;

const HOLDINGS_FOR_ASSET = `SELECT 1 FROM portfolio_asset_holdings WHERE symbol = ?1
  UNION ALL
  SELECT 1 FROM portfolio_holdings WHERE dataset = 'prices_eod' AND symbol = ?1`;

export const D1AssetStoreLive = (db: D1Database): Layer.Layer<AssetStore> =>
  Layer.succeed(
    AssetStore,
    AssetStore.of({
      list: () =>
        query(() =>
          db.prepare(`SELECT * FROM assets ORDER BY symbol`).all<AssetRow>(),
        ).pipe(Effect.map(({ results }) => results.map(fromRow))),

      get: (symbol) =>
        query(() =>
          db
            .prepare(`SELECT * FROM assets WHERE symbol = ?`)
            .bind(symbol)
            .first<AssetRow>(),
        ).pipe(Effect.flatMap(found(symbol))),

      // The asset defaults are assigned in the same batch, only when the
      // asset is new.
      create: (input, now) =>
        query(() =>
          db.batch([
            assignDefaultsOnCreate(
              db,
              { kind: "asset", symbol: input.symbol },
              now,
            ),
            db
              .prepare(
                `INSERT INTO assets
                   (symbol, provider, backfill_start_date, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (symbol) DO NOTHING
                 RETURNING *`,
              )
              .bind(
                input.symbol,
                input.provider,
                input.backfillStartDate,
                Number(input.enabled ?? true),
                now,
                now,
              ),
          ]),
        ).pipe(
          Effect.map(
            ([, inserted]) =>
              (inserted?.results as AssetRow[] | undefined)?.[0] ?? null,
          ),
          Effect.flatMap((row) =>
            row === null
              ? Effect.fail(
                  new AssetError({
                    kind: "conflict",
                    message: `The asset ${input.symbol} already exists`,
                  }),
                )
              : Effect.succeed(fromRow(row)),
          ),
        ),

      update: (symbol, input, now) =>
        query(() =>
          db
            .prepare(
              `UPDATE assets SET
                 provider = coalesce(?2, provider),
                 backfill_start_date = coalesce(?3, backfill_start_date),
                 enabled = coalesce(?4, enabled),
                 updated_at = ?5
               WHERE symbol = ?1
               RETURNING *`,
            )
            .bind(
              symbol,
              input.provider ?? null,
              input.backfillStartDate ?? null,
              input.enabled === undefined ? null : Number(input.enabled),
              now,
            )
            .first<AssetRow>(),
        ).pipe(Effect.flatMap(found(symbol))),

      // Delete configuration in one batch, guarded by all snapshots and active runs.
      remove: (symbol) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `DELETE FROM assets
                 WHERE symbol = ?1
                   AND NOT EXISTS (SELECT 1 ${ACTIVE_RUN_FOR_ASSET})
                   AND NOT EXISTS (${HOLDINGS_FOR_ASSET})
                 RETURNING symbol`,
              )
              .bind(symbol),
            db
              .prepare(
                `DELETE FROM workflow_assignments
                 WHERE subject_kind = 'asset' AND subject_id = ?1
                   AND NOT EXISTS (SELECT 1 FROM assets WHERE symbol = ?1)`,
              )
              .bind(symbol),
            db
              .prepare(
                `SELECT EXISTS (${HOLDINGS_FOR_ASSET}) AS held,
                        (SELECT r.run_id ${ACTIVE_RUN_FOR_ASSET} LIMIT 1) AS run_id
                 FROM assets WHERE symbol = ?1`,
              )
              .bind(symbol),
          ]),
        ).pipe(
          Effect.flatMap(([deleted, , conflict]) => {
            if ((deleted?.results.length ?? 0) > 0) return Effect.void;
            const row = (
              conflict?.results as
                { held: number; run_id: string | null }[] | undefined
            )?.[0];
            return Effect.fail(
              row === undefined
                ? notFound(symbol)
                : new AssetError({
                    kind: "conflict",
                    message:
                      row.held === 1
                        ? `Asset ${symbol} appears in portfolio holdings`
                        : `Run ${row.run_id} for asset ${symbol} is still active; delete the asset once it finishes`,
                  }),
            );
          }),
        ),
    }),
  );
