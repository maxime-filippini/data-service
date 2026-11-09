import { Context, Effect, Schema } from "effect";

import type { Dataset } from "$/market-data/schemas";
import type { RunPage, RunStatus, SymbolStatusView } from "./views";

export const MAX_RUN_PAGE_SIZE = 200;

const CURSOR_SEPARATOR = "_";

/**
 * Validates the opaque ingestion-history position accepted by the app API.
 * Clients should forward `RunPage.nextCursor` unchanged, rather than build it
 * from timestamps or use it as a database identifier.
 */
export const CursorSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[A-Za-z0-9-]{1,64}$/u, {
    message: "Invalid cursor",
  }),
);

export type * from "./views";

/**
 * Selection and cursor for a newest-first ingestion-history read. Apply the
 * same filters when following a returned cursor; `limit` is the requested page
 * size, with HTTP validation enforcing the public maximum.
 */
export interface RunFilter {
  readonly dataset?: Dataset;
  readonly symbol?: string;
  readonly status?: RunStatus;
  /** Opaque position from a previous page's `nextCursor`. */
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * Expected read failure while assembling pipeline views. Lets page/API
 * callers report unavailable history without conflating it with a recorded
 * provider failure or changing any ingestion/job state.
 */
export class PipelineStatusError extends Schema.TaggedError<PipelineStatusError>()(
  "PipelineStatusError",
  { message: Schema.String },
) {}

/**
 * Injectable read-only interface assembling ingestion/job history and symbol
 * status for pages and app JSON routes. Use the control-plane interface for
 * state transitions; these methods only return presentation projections.
 */
export class PipelineStatus extends Context.Service<
  PipelineStatus,
  {
    /** Runs, newest first. */
    readonly listRuns: (
      filter: RunFilter,
    ) => Effect.Effect<RunPage, PipelineStatusError>;
    readonly listSymbols: (filter: {
      readonly dataset?: Dataset;
      readonly enabled?: boolean;
    }) => Effect.Effect<readonly SymbolStatusView[], PipelineStatusError>;
  }
>()("data-service/PipelineStatus") {}

/** A run's position in the newest-first order. */
export const encodeCursor = (createdAt: string, runId: string) =>
  `${createdAt}${CURSOR_SEPARATOR}${runId}`;

export const decodeCursor = (cursor: string) => {
  const index = cursor.lastIndexOf(CURSOR_SEPARATOR);
  return index <= 0
    ? undefined
    : { createdAt: cursor.slice(0, index), runId: cursor.slice(index + 1) };
};
