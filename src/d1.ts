/** Helpers shared by the D1 adapters. */

import { Effect } from "effect";

/**
 * A runner for one adapter's D1 calls: each rejected call fails with the
 * adapter's own expected error, built by `onFailure`.
 *
 * @example
 * const query = d1Query(() => new AssetError({ kind: "database", message: "Could not access assets" }));
 * query(() => db.prepare("SELECT * FROM assets").all());
 */
export const d1Query =
  <E>(onFailure: (cause: unknown) => E) =>
  <A>(operation: () => Promise<A>): Effect.Effect<A, E> =>
    Effect.tryPromise({ try: operation, catch: onFailure });

/**
 * A Drizzle query as a plain D1 statement, for a batch in an adapter that
 * still prepares its own SQL. Only its effect is kept: rows it returns come
 * back unmapped, so use it for writes.
 *
 * @example
 * db.batch([toD1Statement(db, assignDefaultsOnCreate(orm, subject, now)), insert]);
 */
export const toD1Statement = (
  db: D1Database,
  query: { readonly toSQL: () => { sql: string; params: unknown[] } },
): D1PreparedStatement => {
  const { sql, params } = query.toSQL();
  return db.prepare(sql).bind(...params);
};
