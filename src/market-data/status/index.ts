import { Context, Effect, Schema } from "effect";

import type { Dataset } from "$/market-data/schemas";
import type { RunPage, RunStatus, SymbolStatusView } from "./views";

export type * from "./views";

export const MAX_RUN_PAGE_SIZE = 200;

export interface RunFilter {
  readonly dataset?: Dataset;
  readonly symbol?: string;
  readonly status?: RunStatus;
  /** Opaque position from a previous page's `nextCursor`. */
  readonly cursor?: string;
  readonly limit: number;
}

export class PipelineStatusError extends Schema.TaggedError<PipelineStatusError>()(
  "PipelineStatusError",
  { message: Schema.String },
) {}

/** Read-only history of runs and jobs, for the dashboard. */
export class PipelineStatus extends Context.Service<
  PipelineStatus,
  {
    /** Runs, newest first. */
    readonly listRuns: (filter: RunFilter) => Effect.Effect<RunPage, PipelineStatusError>;
    readonly listSymbols: (filter: {
      readonly dataset?: Dataset;
      readonly enabled?: boolean;
    }) => Effect.Effect<readonly SymbolStatusView[], PipelineStatusError>;
  }
>()("data-service/PipelineStatus") {}

const CURSOR_SEPARATOR = "_";

/** A run's position in the newest-first order. */
export const encodeCursor = (createdAt: string, runId: string) => `${createdAt}${CURSOR_SEPARATOR}${runId}`;

export const decodeCursor = (cursor: string) => {
  const index = cursor.lastIndexOf(CURSOR_SEPARATOR);
  return index <= 0 ? undefined : { createdAt: cursor.slice(0, index), runId: cursor.slice(index + 1) };
};

/** ISO timestamp, then a run ID (a UUID). */
export const CursorSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[A-Za-z0-9-]{1,64}$/u, { message: "Invalid cursor" }),
);
