import {
  and,
  eq,
  exists,
  inArray,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Effect, Layer } from "effect";

import { d1Query } from "$/d1";
import { type Asset, AssetError } from "$/assets/contracts";
import { AssetStore } from "$/assets/store";
import {
  ACTIVE_RUN_STATUSES,
  assets,
  portfolioAssetHoldings,
  portfolioHoldings,
  workflowAssignments,
  workflowRuns,
} from "$/db/schema";
import { assignDefaultsOnCreate } from "$/workflows/d1";

const query = d1Query(
  () =>
    new AssetError({ kind: "database", message: "Could not access assets" }),
);

const notFound = (symbol: string) =>
  new AssetError({
    kind: "not_found",
    message: `The asset ${symbol} does not exist`,
  });

const found = (symbol: string) => (row: Asset | undefined) =>
  row === undefined ? Effect.fail(notFound(symbol)) : Effect.succeed(row);

export const D1AssetStoreLive = (db: D1Database): Layer.Layer<AssetStore> => {
  const orm = drizzle(db);

  const bySymbol = (symbol: string): SQL => eq(assets.symbol, symbol);

  /** An active workflow run for the asset. */
  const activeRun = (symbol: string) =>
    orm
      .select({ runId: workflowRuns.runId })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.subjectKind, "asset"),
          eq(workflowRuns.subjectId, symbol),
          inArray(workflowRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );

  /** A holding of the asset in any snapshot, workflow or legacy. */
  const holding = (symbol: string) =>
    unionAll(
      orm
        .select({ one: sql`1` })
        .from(portfolioAssetHoldings)
        .where(eq(portfolioAssetHoldings.symbol, symbol)),
      orm
        .select({ one: sql`1` })
        .from(portfolioHoldings)
        .where(
          and(
            eq(portfolioHoldings.dataset, "prices_eod"),
            eq(portfolioHoldings.symbol, symbol),
          ),
        ),
    );

  return Layer.succeed(
    AssetStore,
    AssetStore.of({
      list: () => query(() => orm.select().from(assets).orderBy(assets.symbol)),

      get: (symbol) =>
        query(() =>
          orm.select().from(assets).where(bySymbol(symbol)).get(),
        ).pipe(Effect.flatMap(found(symbol))),

      // The asset defaults are assigned in the same batch, only when the
      // asset is new.
      create: (input, now) =>
        query(() =>
          orm.batch([
            assignDefaultsOnCreate(
              orm,
              { kind: "asset", symbol: input.symbol },
              now,
            ),
            orm
              .insert(assets)
              .values({
                symbol: input.symbol,
                provider: input.provider,
                backfillStartDate: input.backfillStartDate,
                enabled: input.enabled ?? true,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing()
              .returning(),
          ]),
        ).pipe(
          Effect.flatMap(([, [inserted]]) =>
            inserted === undefined
              ? Effect.fail(
                  new AssetError({
                    kind: "conflict",
                    message: `The asset ${input.symbol} already exists`,
                  }),
                )
              : Effect.succeed(inserted),
          ),
        ),

      // Omitted fields are left out of the SET clause.
      update: (symbol, input, now) =>
        query(() =>
          orm
            .update(assets)
            .set({ ...input, updatedAt: now })
            .where(bySymbol(symbol))
            .returning()
            .get(),
        ).pipe(Effect.flatMap(found(symbol))),

      // Delete configuration in one batch, guarded by all snapshots and active runs.
      remove: (symbol) =>
        query(() =>
          orm.batch([
            orm
              .delete(assets)
              .where(
                and(
                  bySymbol(symbol),
                  notExists(activeRun(symbol)),
                  notExists(holding(symbol)),
                ),
              )
              .returning({ symbol: assets.symbol }),
            orm.delete(workflowAssignments).where(
              and(
                eq(workflowAssignments.subjectKind, "asset"),
                eq(workflowAssignments.subjectId, symbol),
                notExists(
                  orm
                    .select({ one: sql`1` })
                    .from(assets)
                    .where(bySymbol(symbol)),
                ),
              ),
            ),
            orm
              .select({
                held: sql<boolean>`${exists(holding(symbol))}`.mapWith(Boolean),
                runId: sql<string | null>`(${activeRun(symbol).limit(1)})`,
              })
              .from(assets)
              .where(bySymbol(symbol)),
          ]),
        ).pipe(
          Effect.flatMap(([deleted, , [conflict]]) => {
            if (deleted.length > 0) return Effect.void;
            return Effect.fail(
              conflict === undefined
                ? notFound(symbol)
                : new AssetError({
                    kind: "conflict",
                    message: conflict.held
                      ? `Asset ${symbol} appears in portfolio holdings`
                      : `Run ${conflict.runId} for asset ${symbol} is still active; delete the asset once it finishes`,
                  }),
            );
          }),
        ),
    }),
  );
};
