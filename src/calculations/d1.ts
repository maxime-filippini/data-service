import { Effect, Layer } from "effect";

import {
  type Calculation,
  CalculationError,
  calculationOutputKey,
  type CalculationRun,
  Calculations,
  type NewCalculation,
  type RunStatus,
  type RunTrigger,
} from "$/calculations";

interface CalculationRow {
  readonly calculation_id: string;
  readonly name: string;
  readonly type: string;
  readonly params_json: string;
  readonly cron: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** JSON array, in run order. */
  readonly portfolio_ids: string;
}

interface RunRow {
  readonly run_id: string;
  readonly calculation_id: string;
  readonly trigger: RunTrigger;
  readonly as_of: string;
  readonly params_json: string;
  readonly status: RunStatus;
  readonly portfolios_json: string | null;
  readonly row_count: number | null;
  readonly output_etag: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

const databaseError = () => new CalculationError({ kind: "database", message: "Could not access calculations" });
const notFound = () => new CalculationError({ kind: "not_found", message: "The calculation does not exist" });

const query = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: databaseError });

const fromRunRow = (row: RunRow): CalculationRun => ({
  runId: row.run_id,
  calculationId: row.calculation_id,
  trigger: row.trigger,
  asOf: row.as_of,
  params: JSON.parse(row.params_json),
  status: row.status,
  portfolios: row.portfolios_json === null ? null : JSON.parse(row.portfolios_json),
  rowCount: row.row_count,
  outputEtag: row.output_etag,
  error: row.error,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

const fromRow = (row: CalculationRow, lastRun: RunRow | undefined): Calculation => ({
  id: row.calculation_id,
  name: row.name,
  type: row.type,
  params: JSON.parse(row.params_json),
  portfolioIds: JSON.parse(row.portfolio_ids),
  cron: row.cron,
  enabled: row.enabled === 1,
  outputKey: calculationOutputKey(row.calculation_id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastRun: lastRun === undefined ? null : fromRunRow(lastRun),
});

export const D1CalculationsLive = (db: D1Database): Layer.Layer<Calculations> => {
  /** Calculations (one, or all when `id` is null) with their portfolios and latest run. */
  const load = (id: string | null) =>
    query(() =>
      db.batch([
        db
          .prepare(
            `SELECT c.*, (
               SELECT json_group_array(portfolio_id) FROM (
                 SELECT portfolio_id FROM calculation_portfolios
                 WHERE calculation_id = c.calculation_id
                 ORDER BY position
               )
             ) AS portfolio_ids
             FROM calculations c
             WHERE ?1 IS NULL OR c.calculation_id = ?1
             ORDER BY c.name, c.calculation_id`,
          )
          .bind(id),
        db
          .prepare(
            `SELECT r.* FROM calculations c
             JOIN calculation_runs r ON r.run_id = (
               SELECT run_id FROM calculation_runs
               WHERE calculation_id = c.calculation_id
               ORDER BY created_at DESC, run_id DESC
               LIMIT 1
             )
             WHERE ?1 IS NULL OR c.calculation_id = ?1`,
          )
          .bind(id),
      ]),
    ).pipe(
      Effect.map(([calculations, runs]) => {
        const lastRuns = new Map(((runs?.results ?? []) as RunRow[]).map((run) => [run.calculation_id, run]));
        return ((calculations?.results ?? []) as CalculationRow[]).map((row) =>
          fromRow(row, lastRuns.get(row.calculation_id)),
        );
      }),
    );

  const get = (id: string) =>
    load(id).pipe(Effect.flatMap(([calculation]) => (calculation === undefined ? Effect.fail(notFound()) : Effect.succeed(calculation))));

  /** Fails with `invalid` unless every portfolio exists. */
  const requirePortfolios = (ids: readonly string[]) =>
    query(() =>
      db
        .prepare(
          `SELECT j.value AS id FROM json_each(?) j
           WHERE NOT EXISTS (SELECT 1 FROM portfolios p WHERE p.portfolio_id = j.value)`,
        )
        .bind(JSON.stringify(ids))
        .all<{ id: string }>(),
    ).pipe(
      Effect.flatMap(({ results }) =>
        results.length === 0
          ? Effect.void
          : Effect.fail(
              new CalculationError({
                kind: "invalid",
                message: `No such portfolios: ${results.map((row) => row.id).join(", ")}`,
                portfolioIds: results.map((row) => row.id),
              }),
            ),
      ),
    );

  /** Statements that set a calculation's portfolios, if the calculation exists. */
  const setPortfolios = (id: string, portfolioIds: readonly string[]) => [
    db.prepare(`DELETE FROM calculation_portfolios WHERE calculation_id = ?`).bind(id),
    db
      .prepare(
        `INSERT INTO calculation_portfolios (calculation_id, portfolio_id, position)
         SELECT ?1, j.value, j.key FROM json_each(?2) j
         WHERE EXISTS (SELECT 1 FROM calculations WHERE calculation_id = ?1)`,
      )
      .bind(id, JSON.stringify(portfolioIds)),
  ];

  /** Runs a write batch. A portfolio deleted since it was checked is reported as missing. */
  const write = (statements: D1PreparedStatement[]) =>
    Effect.tryPromise({
      try: () => db.batch(statements),
      catch: (error) =>
        String(error).includes("FOREIGN KEY constraint failed")
          ? new CalculationError({ kind: "invalid", message: "A portfolio was deleted while saving the calculation" })
          : databaseError(),
    });

  const runs = (where: string, ...bindings: unknown[]) =>
    query(() =>
      db
        .prepare(`SELECT * FROM calculation_runs WHERE ${where}`)
        .bind(...bindings)
        .all<RunRow>(),
    ).pipe(Effect.map(({ results }) => results.map(fromRunRow)));

  return Layer.succeed(
    Calculations,
    Calculations.of({
      list: () => load(null),

      get,

      create: (calculation: NewCalculation, now) =>
        Effect.gen(function* () {
          yield* requirePortfolios(calculation.portfolioIds);
          yield* write([
            db
              .prepare(
                `INSERT INTO calculations
                   (calculation_id, name, type, params_json, cron, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                calculation.id,
                calculation.name,
                calculation.type,
                JSON.stringify(calculation.params),
                calculation.cron,
                Number(calculation.enabled),
                now,
                now,
              ),
            ...setPortfolios(calculation.id, calculation.portfolioIds),
          ]);
          return yield* get(calculation.id);
        }),

      update: (id, patch, now) =>
        Effect.gen(function* () {
          if (patch.portfolioIds !== undefined) yield* requirePortfolios(patch.portfolioIds);
          const [updated] = yield* write([
            db
              .prepare(
                `UPDATE calculations
                 SET name = coalesce(?1, name),
                     params_json = coalesce(?2, params_json),
                     cron = coalesce(?3, cron),
                     enabled = coalesce(?4, enabled),
                     updated_at = ?5
                 WHERE calculation_id = ?6
                 RETURNING calculation_id`,
              )
              .bind(
                patch.name ?? null,
                patch.params === undefined ? null : JSON.stringify(patch.params),
                patch.cron ?? null,
                patch.enabled === undefined ? null : Number(patch.enabled),
                now,
                id,
              ),
            ...(patch.portfolioIds === undefined ? [] : setPortfolios(id, patch.portfolioIds)),
          ]);
          if ((updated?.results ?? []).length === 0) return yield* Effect.fail(notFound());
          return yield* get(id);
        }),

      remove: (id) =>
        query(() =>
          db.prepare(`DELETE FROM calculations WHERE calculation_id = ? RETURNING calculation_id`).bind(id).first(),
        ).pipe(Effect.flatMap((row) => (row === null ? Effect.fail(notFound()) : Effect.void))),

      startRun: (run) =>
        Effect.gen(function* () {
          const insert = (status: "running" | "skipped", error: string | null) =>
            query(() =>
              db
                .prepare(
                  `INSERT INTO calculation_runs
                     (run_id, calculation_id, trigger, as_of, params_json, status, error, created_at, completed_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CASE WHEN ?6 = 'skipped' THEN ?8 END)
                   ON CONFLICT DO NOTHING
                   RETURNING run_id`,
                )
                .bind(
                  run.runId,
                  run.calculationId,
                  run.trigger,
                  run.asOf,
                  JSON.stringify(run.params),
                  status,
                  error,
                  run.createdAt,
                )
                .first<{ run_id: string }>(),
            );
          if ((yield* insert("running", null)) !== null) return "running" as const;

          // Another run holds the calculation's one running slot.
          const [running] = yield* runs(`calculation_id = ? AND status = 'running'`, run.calculationId);
          const skipped = yield* insert(
            "skipped",
            running === undefined ? "Another run was going" : `Run ${running.runId} was still going`,
          );
          if (skipped === null) return yield* Effect.fail(databaseError());
          return "skipped" as const;
        }),

      // Unconditional: a run failed by mistake as stuck still gets its real result.
      finishRun: (runId, result, at) =>
        query(() =>
          db
            .prepare(
              `UPDATE calculation_runs
               SET status = ?, error = ?, portfolios_json = ?, row_count = ?, output_etag = ?, completed_at = ?
               WHERE run_id = ?`,
            )
            .bind(
              result.status,
              result.error,
              JSON.stringify(result.portfolios),
              result.rowCount,
              result.outputEtag,
              at,
              runId,
            )
            .run(),
        ).pipe(Effect.asVoid),

      failRun: (runId, error, at) =>
        query(() =>
          db
            .prepare(
              `UPDATE calculation_runs SET status = 'failed', error = ?, completed_at = ?
               WHERE run_id = ? AND status = 'running'`,
            )
            .bind(error, at, runId)
            .run(),
        ).pipe(Effect.asVoid),

      runningRuns: (calculationId) =>
        runs(`status = 'running' AND (?1 IS NULL OR calculation_id = ?1) ORDER BY created_at`, calculationId ?? null),

      listRuns: (calculationId, limit) =>
        runs(`calculation_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?`, calculationId, limit),

      getRun: (runId) =>
        runs(`run_id = ?`, runId).pipe(
          Effect.flatMap(([run]) =>
            run === undefined
              ? Effect.fail(new CalculationError({ kind: "not_found", message: "The run does not exist" }))
              : Effect.succeed(run),
          ),
        ),
    }),
  );
};
