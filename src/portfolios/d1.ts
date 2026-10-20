import { Effect, Layer } from "effect";

import {
  type Holding,
  type NewSnapshot,
  type Portfolio,
  PortfolioError,
  Portfolios,
  type PortfolioSummary,
  type Snapshot,
} from "$/portfolios";

interface PortfolioRow {
  readonly portfolio_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SummaryRow extends PortfolioRow {
  readonly snapshot_count: number;
  readonly latest_holdings_date: string | null;
}

interface HoldingRow {
  readonly holdings_date: string;
  readonly created_at: string;
  readonly symbol: string;
  readonly weight: number;
}

const databaseError = () => new PortfolioError({ kind: "database", message: "Could not access portfolios" });
const notFound = () => new PortfolioError({ kind: "not_found", message: "The portfolio does not exist" });
const dateTaken = (holdingsDate: string) =>
  new PortfolioError({ kind: "conflict", message: `The portfolio already has a snapshot for ${holdingsDate}` });

const inUse = (calculations: readonly { id: string; name: string }[]) =>
  new PortfolioError({
    kind: "conflict",
    message:
      calculations.length === 0
        ? "A calculation uses the portfolio"
        : `Used by calculations: ${calculations.map((calculation) => calculation.name).join(", ")}`,
    calculations,
  });

const symbolsOf = (snapshot: NewSnapshot) => snapshot.holdings.map((holding) => holding.symbol);

const query = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: databaseError });

/** Groups holding rows, sorted by date, into snapshots. */
const toSnapshots = (rows: readonly HoldingRow[]): Snapshot[] => {
  const snapshots: { holdingsDate: string; createdAt: string; holdings: Holding[] }[] = [];
  for (const row of rows) {
    const last = snapshots.at(-1);
    const holding = { symbol: row.symbol, weight: row.weight };
    if (last?.holdingsDate === row.holdings_date) last.holdings.push(holding);
    else snapshots.push({ holdingsDate: row.holdings_date, createdAt: row.created_at, holdings: [holding] });
  }
  return snapshots;
};

export const D1PortfoliosLive = (db: D1Database): Layer.Layer<Portfolios> => {
  /** The portfolio and its holdings dated on or before `asOf` (all when null). */
  const load = (id: string, asOf: string | null) =>
    query(() =>
      db.batch([
        db.prepare(`SELECT * FROM portfolios WHERE portfolio_id = ?`).bind(id),
        db
          .prepare(
            `SELECT s.holdings_date, s.created_at, h.symbol, h.weight
             FROM portfolio_snapshots s
             JOIN portfolio_holdings h USING (portfolio_id, holdings_date)
             WHERE s.portfolio_id = ?1 AND (?2 IS NULL OR s.holdings_date <= ?2)
             ORDER BY s.holdings_date, h.symbol`,
          )
          .bind(id, asOf),
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
          snapshots: toSnapshots((holdings?.results ?? []) as HoldingRow[]),
        } satisfies Portfolio);
      }),
    );

  const requireTracked = (symbols: readonly string[]) =>
    query(() =>
      db
        .prepare(
          `SELECT j.value AS symbol FROM json_each(?) j
           WHERE NOT EXISTS (
             SELECT 1 FROM tracked_symbols t WHERE t.dataset = 'prices_eod' AND t.symbol = j.value
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
                message: `Not tracked in prices_eod: ${results.map((row) => row.symbol).join(", ")}`,
                symbols: results.map((row) => row.symbol),
              }),
            ),
      ),
    );

  /** Statements that insert a snapshot. Holdings go in as one JSON parameter. */
  const insertSnapshot = (id: string, snapshot: NewSnapshot, now: string) => [
    db
      .prepare(`INSERT INTO portfolio_snapshots (portfolio_id, holdings_date, created_at) VALUES (?, ?, ?)`)
      .bind(id, snapshot.holdingsDate, now),
    db
      .prepare(
        `INSERT INTO portfolio_holdings (portfolio_id, holdings_date, dataset, symbol, weight)
         SELECT ?1, ?2, 'prices_eod', j.value ->> '$.symbol', j.value ->> '$.weight'
         FROM json_each(?3) j`,
      )
      .bind(id, snapshot.holdingsDate, JSON.stringify(snapshot.holdings)),
  ];

  /** Runs a write batch. A second snapshot for the same date, added concurrently, is a conflict. */
  const write = (statements: D1PreparedStatement[], holdingsDate?: string) =>
    Effect.tryPromise({
      try: () => db.batch(statements),
      catch: (error) =>
        holdingsDate !== undefined && String(error).includes("UNIQUE constraint failed: portfolio_snapshots")
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
            results.map(
              (row): PortfolioSummary => ({
                id: row.portfolio_id,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                snapshotCount: row.snapshot_count,
                latestHoldingsDate: row.latest_holdings_date,
              }),
            ),
          ),
        ),

      get: (id) => load(id, null),

      create: (input, id, now) =>
        Effect.gen(function* () {
          if (input.snapshot !== undefined) yield* requireTracked(symbolsOf(input.snapshot));
          yield* write([
            db
              .prepare(`INSERT INTO portfolios (portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
              .bind(id, input.name, now, now),
            ...(input.snapshot === undefined ? [] : insertSnapshot(id, input.snapshot, now)),
          ]);
          return yield* load(id, null);
        }),

      rename: (id, name, now) =>
        query(() =>
          db
            .prepare(`UPDATE portfolios SET name = ?, updated_at = ? WHERE portfolio_id = ? RETURNING portfolio_id`)
            .bind(name, now, id)
            .first(),
        ).pipe(Effect.flatMap((row) => (row === null ? Effect.fail(notFound()) : load(id, null)))),

      remove: (id) =>
        Effect.gen(function* () {
          const { results: users } = yield* query(() =>
            db
              .prepare(
                `SELECT c.calculation_id AS id, c.name
                 FROM calculation_portfolios cp JOIN calculations c USING (calculation_id)
                 WHERE cp.portfolio_id = ?
                 ORDER BY c.name, c.calculation_id`,
              )
              .bind(id)
              .all<{ id: string; name: string }>(),
          );
          if (users.length > 0) return yield* Effect.fail(inUse(users));
          const row = yield* Effect.tryPromise({
            try: () => db.prepare(`DELETE FROM portfolios WHERE portfolio_id = ? RETURNING portfolio_id`).bind(id).first(),
            // A calculation started using it since the check.
            catch: (error) => (String(error).includes("FOREIGN KEY constraint failed") ? inUse([]) : databaseError()),
          });
          if (row === null) return yield* Effect.fail(notFound());
        }),

      addSnapshot: (id, snapshot, now) =>
        Effect.gen(function* () {
          const existing = yield* query(() =>
            db
              .prepare(
                `SELECT EXISTS (
                   SELECT 1 FROM portfolio_snapshots WHERE portfolio_id = ?1 AND holdings_date = ?2
                 ) AS taken
                 FROM portfolios WHERE portfolio_id = ?1`,
              )
              .bind(id, snapshot.holdingsDate)
              .first<{ taken: number }>(),
          );
          if (existing === null) return yield* Effect.fail(notFound());
          if (existing.taken === 1) return yield* Effect.fail(dateTaken(snapshot.holdingsDate));
          yield* requireTracked(symbolsOf(snapshot));
          yield* write(
            [
              ...insertSnapshot(id, snapshot, now),
              db.prepare(`UPDATE portfolios SET updated_at = ? WHERE portfolio_id = ?`).bind(now, id),
            ],
            snapshot.holdingsDate,
          );
          return {
            holdingsDate: snapshot.holdingsDate,
            createdAt: now,
            holdings: [...snapshot.holdings].sort((a, b) => (a.symbol < b.symbol ? -1 : 1)),
          } satisfies Snapshot;
        }),

      removeSnapshot: (id, holdingsDate, now) =>
        query(() =>
          db
            .prepare(
              `DELETE FROM portfolio_snapshots WHERE portfolio_id = ? AND holdings_date = ? RETURNING holdings_date`,
            )
            .bind(id, holdingsDate)
            .first(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.fail(
                  new PortfolioError({ kind: "not_found", message: `The portfolio has no snapshot for ${holdingsDate}` }),
                )
              : query(() =>
                  db.prepare(`UPDATE portfolios SET updated_at = ? WHERE portfolio_id = ?`).bind(now, id).run(),
                ),
          ),
          Effect.asVoid,
        ),

      requireTracked,

      forEngine: (id, asOf) =>
        load(id, asOf).pipe(
          Effect.map((portfolio) => ({
            id: portfolio.id,
            name: portfolio.name,
            snapshots: portfolio.snapshots.map(({ holdingsDate, holdings }) => ({ holdingsDate, holdings })),
          })),
        ),
    }),
  );
};
