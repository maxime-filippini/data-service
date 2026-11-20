import { Effect, Layer } from "effect";

import { d1Query } from "$/d1";
import {
  type Holding,
  type NewSnapshot,
  type Portfolio,
  PortfolioError,
  type PortfolioSummary,
  type Snapshot,
} from "$/portfolios/contracts";
import { Portfolios } from "$/portfolios/store";
import { assignDefaultsOnCreate } from "$/workflows/d1";

const ACTIVE_RUN_FOR_PORTFOLIO = `FROM workflow_runs
  WHERE subject_kind = 'portfolio' AND subject_id = ?1
    AND status IN ('queued', 'running', 'waiting')`;

/**
 * Private persisted portfolio metadata. Holdings are loaded separately and
 * combined into the `Portfolio` detail view; `asset_symbol` marks retained
 * legacy single-asset portfolios.
 */
interface PortfolioRow {
  readonly portfolio_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly asset_symbol: string | null;
}

/**
 * Private list-query projection adding snapshot counts/dates to metadata.
 * Mapped to `PortfolioSummary` without loading the holdings history.
 */
interface SummaryRow extends PortfolioRow {
  readonly snapshot_count: number;
  readonly latest_holdings_date: string | null;
}

/**
 * Private joined snapshot/holding result ordered by date and symbol.
 * `toSnapshots` groups these flat rows into complete dated holdings sets.
 */
interface HoldingRow {
  readonly holdings_date: string;
  readonly created_at: string;
  readonly symbol: string;
  readonly weight: number;
}

const databaseError = () =>
  new PortfolioError({
    kind: "database",
    message: "Could not access portfolios",
  });
const notFound = () =>
  new PortfolioError({
    kind: "not_found",
    message: "The portfolio does not exist",
  });
const managed = (symbol: string) =>
  new PortfolioError({
    kind: "conflict",
    message: `This is the single-asset portfolio of ${symbol}, which can't be changed`,
  });
const dateTaken = (holdingsDate: string) =>
  new PortfolioError({
    kind: "conflict",
    message: `The portfolio already has a snapshot for ${holdingsDate}`,
  });

const referenced = () =>
  new PortfolioError({
    kind: "conflict",
    message: "The portfolio is still referenced by historical records",
  });

const symbolsOf = (snapshot: NewSnapshot) =>
  snapshot.holdings.map((holding) => holding.symbol);

const query = d1Query(databaseError);

/** Groups holding rows, sorted by date, into snapshots. */
const toSnapshots = (rows: readonly HoldingRow[]): Snapshot[] => {
  const snapshots: {
    holdingsDate: string;
    createdAt: string;
    holdings: Holding[];
  }[] = [];
  for (const row of rows) {
    const last = snapshots.at(-1);
    const holding = { symbol: row.symbol, weight: row.weight };
    if (last?.holdingsDate === row.holdings_date) last.holdings.push(holding);
    else
      snapshots.push({
        holdingsDate: row.holdings_date,
        createdAt: row.created_at,
        holdings: [holding],
      });
  }
  return snapshots;
};

export const D1PortfoliosLive = (db: D1Database): Layer.Layer<Portfolios> => {
  /** Load snapshots through `asOf`. With `from`, start at the snapshot effective on that date. */
  const load = (id: string, asOf: string | null, from: string | null = null) =>
    query(() =>
      db.batch([
        db.prepare(`SELECT * FROM portfolios WHERE portfolio_id = ?`).bind(id),
        db
          .prepare(
            `WITH holdings AS (
               SELECT holdings_date, symbol, weight FROM portfolio_holdings WHERE portfolio_id = ?1
               UNION ALL
               SELECT holdings_date, symbol, weight FROM portfolio_asset_holdings WHERE portfolio_id = ?1
             )
             SELECT s.holdings_date, s.created_at, h.symbol, h.weight
             FROM portfolio_snapshots s
             JOIN holdings h USING (holdings_date)
             WHERE s.portfolio_id = ?1 AND (?2 IS NULL OR s.holdings_date <= ?2)
               AND (?3 IS NULL OR s.holdings_date > ?3 OR s.holdings_date = (
                 SELECT max(holdings_date) FROM portfolio_snapshots
                 WHERE portfolio_id = ?1 AND holdings_date <= ?3
               ))
             ORDER BY s.holdings_date, h.symbol`,
          )
          .bind(id, asOf, from),
      ]),
    ).pipe(
      Effect.flatMap(([portfolio, holdings]) => {
        const row = (portfolio?.results as PortfolioRow[] | undefined)?.[0];
        if (row === undefined) return Effect.fail(notFound());
        return Effect.succeed({
          id: row.portfolio_id,
          name: row.name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          assetSymbol: row.asset_symbol,
          snapshots: toSnapshots((holdings?.results ?? []) as HoldingRow[]),
        } satisfies Portfolio);
      }),
    );

  const requireAssets = (symbols: readonly string[]) =>
    query(() =>
      db
        .prepare(
          `SELECT j.value AS symbol FROM json_each(?1) j
           WHERE NOT EXISTS (
             SELECT 1 FROM assets a WHERE a.symbol = j.value
           )`,
        )
        .bind(JSON.stringify(symbols))
        .all<{ symbol: string }>(),
    ).pipe(
      Effect.flatMap(({ results }) =>
        results.length === 0
          ? Effect.void
          : Effect.fail(
              new PortfolioError({
                kind: "untracked_symbols",
                message: `Unknown assets: ${results.map((row) => row.symbol).join(", ")}`,
                symbols: results.map((row) => row.symbol),
              }),
            ),
      ),
    );

  /** Fails unless the portfolio exists and isn't a retained single-asset portfolio. */
  const requireEditable = (id: string) =>
    query(() =>
      db
        .prepare(`SELECT asset_symbol FROM portfolios WHERE portfolio_id = ?`)
        .bind(id)
        .first<{ asset_symbol: string | null }>(),
    ).pipe(
      Effect.flatMap((row) => {
        if (row === null) return Effect.fail(notFound());
        return row.asset_symbol === null
          ? Effect.void
          : Effect.fail(managed(row.asset_symbol));
      }),
    );

  /** Write new snapshots to `portfolio_asset_holdings` (referencing `assets`). */
  const insertSnapshot = (id: string, snapshot: NewSnapshot, now: string) => {
    const { holdingsDate } = snapshot;
    const holdings = JSON.stringify(snapshot.holdings);
    return [
      db
        .prepare(
          `INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at) VALUES (?, ?, ?)`,
        )
        .bind(id, holdingsDate, now),
      db
        .prepare(
          `INSERT INTO portfolio_asset_holdings (portfolio_id, holdings_date, symbol, weight)
           SELECT ?1, ?2, j.value ->> '$.symbol', j.value ->> '$.weight'
           FROM json_each(?3) j`,
        )
        .bind(id, holdingsDate, holdings),
    ];
  };

  /** Runs a write batch. A second snapshot for the same date, added concurrently, is a conflict. */
  const write = (statements: D1PreparedStatement[], holdingsDate?: string) =>
    Effect.tryPromise({
      try: () => db.batch(statements),
      catch: (error) =>
        holdingsDate !== undefined &&
        String(error).includes("UNIQUE constraint failed: portfolio_snapshots")
          ? dateTaken(holdingsDate)
          : databaseError(),
    });

  return Layer.succeed(
    Portfolios,
    Portfolios.of({
      list: () =>
        query(() =>
          db
            .prepare(
              `SELECT p.*, count(s.holdings_date) AS snapshot_count, max(s.holdings_date) AS latest_holdings_date
               FROM portfolios p
               LEFT JOIN portfolio_snapshots s USING (portfolio_id)
               GROUP BY p.portfolio_id
               ORDER BY p.name, p.portfolio_id`,
            )
            .all<SummaryRow>(),
        ).pipe(
          Effect.map(({ results }) =>
            results.map((row): PortfolioSummary => ({
              id: row.portfolio_id,
              name: row.name,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              assetSymbol: row.asset_symbol,
              snapshotCount: row.snapshot_count,
              latestHoldingsDate: row.latest_holdings_date,
            })),
          ),
        ),

      get: (id) => load(id, null),

      holdingsAt: (id, date) =>
        load(id, date, date).pipe(
          Effect.flatMap(({ snapshots: [snapshot] }) =>
            snapshot === undefined
              ? Effect.fail(
                  new PortfolioError({
                    kind: "no_holdings",
                    message: `The portfolio has no snapshot on or before ${date}`,
                  }),
                )
              : Effect.succeed(snapshot),
          ),
        ),

      holdingsBetween: (id, from, through) =>
        load(id, through, from).pipe(
          Effect.map((portfolio) => portfolio.snapshots),
        ),

      create: (input, id, now) =>
        Effect.gen(function* () {
          if (input.snapshot !== undefined)
            yield* requireAssets(symbolsOf(input.snapshot));
          yield* write([
            assignDefaultsOnCreate(db, { kind: "portfolio", id }, now),
            db
              .prepare(
                `INSERT INTO portfolios (portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
              )
              .bind(id, input.name, now, now),
            ...(input.snapshot === undefined
              ? []
              : insertSnapshot(id, input.snapshot, now)),
          ]);
          return yield* load(id, null);
        }),

      rename: (id, name, now) =>
        Effect.gen(function* () {
          yield* requireEditable(id);
          const row = yield* query(() =>
            db
              .prepare(
                `UPDATE portfolios SET name = ?, updated_at = ? WHERE portfolio_id = ? RETURNING portfolio_id`,
              )
              .bind(name, now, id)
              .first(),
          );
          if (row === null) return yield* Effect.fail(notFound());
          return yield* load(id, null);
        }),

      remove: (id) =>
        Effect.gen(function* () {
          yield* requireEditable(id);
          const [deleted, , active] = yield* Effect.tryPromise({
            try: () =>
              db.batch([
                db
                  .prepare(
                    `DELETE FROM portfolios WHERE portfolio_id = ?1
                       AND NOT EXISTS (SELECT 1 ${ACTIVE_RUN_FOR_PORTFOLIO})
                     RETURNING portfolio_id`,
                  )
                  .bind(id),
                db
                  .prepare(
                    `DELETE FROM workflow_assignments
                     WHERE subject_kind = 'portfolio' AND subject_id = ?1
                       AND NOT EXISTS (SELECT 1 FROM portfolios WHERE portfolio_id = ?1)`,
                  )
                  .bind(id),
                db
                  .prepare(`SELECT run_id ${ACTIVE_RUN_FOR_PORTFOLIO} LIMIT 1`)
                  .bind(id),
              ]),
            // Historical tables such as calculation_portfolios may still hold a FK.
            catch: (error) =>
              String(error).includes("FOREIGN KEY constraint failed")
                ? referenced()
                : databaseError(),
          });
          if ((deleted?.results.length ?? 0) > 0) return;
          const run = (
            active?.results as { run_id: string }[] | undefined
          )?.[0];
          if (run === undefined) return yield* Effect.fail(notFound());
          return yield* new PortfolioError({
            kind: "conflict",
            message: `Run ${run.run_id} for this portfolio is still active; delete the portfolio once it finishes`,
          });
        }),

      addSnapshot: (id, snapshot, now) =>
        Effect.gen(function* () {
          const existing = yield* query(() =>
            db
              .prepare(
                `SELECT asset_symbol, EXISTS (
                   SELECT 1 FROM portfolio_snapshots WHERE portfolio_id = ?1 AND holdings_date = ?2
                 ) AS taken
                 FROM portfolios WHERE portfolio_id = ?1`,
              )
              .bind(id, snapshot.holdingsDate)
              .first<{ asset_symbol: string | null; taken: number }>(),
          );
          if (existing === null) return yield* Effect.fail(notFound());
          if (existing.asset_symbol !== null)
            return yield* Effect.fail(managed(existing.asset_symbol));
          if (existing.taken === 1)
            return yield* Effect.fail(dateTaken(snapshot.holdingsDate));
          yield* requireAssets(symbolsOf(snapshot));
          yield* write(
            [
              ...insertSnapshot(id, snapshot, now),
              db
                .prepare(
                  `UPDATE portfolios SET updated_at = ? WHERE portfolio_id = ?`,
                )
                .bind(now, id),
            ],
            snapshot.holdingsDate,
          );
          return {
            holdingsDate: snapshot.holdingsDate,
            createdAt: now,
            holdings: [...snapshot.holdings].sort((a, b) =>
              a.symbol < b.symbol ? -1 : 1,
            ),
          } satisfies Snapshot;
        }),

      removeSnapshot: (id, holdingsDate, now) =>
        Effect.gen(function* () {
          yield* requireEditable(id);
          const row = yield* query(() =>
            db
              .prepare(
                `DELETE FROM portfolio_snapshots WHERE portfolio_id = ? AND holdings_date = ? RETURNING holdings_date`,
              )
              .bind(id, holdingsDate)
              .first(),
          );
          if (row === null) {
            return yield* Effect.fail(
              new PortfolioError({
                kind: "not_found",
                message: `The portfolio has no snapshot for ${holdingsDate}`,
              }),
            );
          }
          yield* query(() =>
            db
              .prepare(
                `UPDATE portfolios SET updated_at = ? WHERE portfolio_id = ?`,
              )
              .bind(now, id)
              .run(),
          );
        }),
    }),
  );
};
