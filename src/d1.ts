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
