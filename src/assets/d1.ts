import { Effect, Layer } from "effect";

import { type Asset, AssetError } from "$/assets/contracts";
import { Assets } from "$/assets/store";

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

const query = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new AssetError({ kind: "database", message: "Could not access assets" }),
  });

const notFound = (symbol: string) =>
  new AssetError({
    kind: "not_found",
    message: `The asset ${symbol} does not exist`,
  });

const found = (symbol: string) => (row: AssetRow | null | undefined) =>
  row == null ? Effect.fail(notFound(symbol)) : Effect.succeed(fromRow(row));

export const D1AssetsLive = (db: D1Database): Layer.Layer<Assets> =>
  Layer.succeed(
    Assets,
    Assets.of({
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

      create: (input, now) =>
        query(() =>
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
            )
            .first<AssetRow>(),
        ).pipe(
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

      // Assignments go in the same batch, so none outlives its subject.
      remove: (symbol) =>
        query(() =>
          db.batch([
            db
              .prepare(
                `DELETE FROM workflow_assignments
                 WHERE subject_kind = 'asset' AND subject_id = ?`,
              )
              .bind(symbol),
            db
              .prepare(`DELETE FROM assets WHERE symbol = ? RETURNING symbol`)
              .bind(symbol),
          ]),
        ).pipe(
          Effect.flatMap(([, deleted]) =>
            (deleted?.results.length ?? 0) === 0
              ? Effect.fail(notFound(symbol))
              : Effect.void,
          ),
        ),
    }),
  );
