import { Effect, type Layer, Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import {
  DatasetError,
  PUBLISHED_DATASETS,
  PublicationParamsSchema,
  PublicationsQuerySchema,
  type PublishedDataset,
} from "$/datasets/contracts";
import { currentDatasetData } from "$/datasets/operations";
import {
  DatasetPublicationStore,
  type DatasetObjectStore,
} from "$/datasets/store";
import { effectValidator } from "$/effect-validator";
import { runHttp } from "$/http/run-effect";
import { type Subject, SubjectSchema } from "$/workflows/contracts";

/** The services dataset routes need. */
export type DatasetServices = DatasetPublicationStore | DatasetObjectStore;

/** What dataset routes select from request bindings. */
export interface DatasetDependencies {
  readonly datasetsFor: (
    env: CloudflareBindings,
  ) => Layer.Layer<DatasetServices>;
}

/** The subject a path names, or a 404 for one that cannot exist. */
const subjectOf = (
  dataset: PublishedDataset,
  kind: "asset" | "portfolio",
  id: string,
): Effect.Effect<Subject, DatasetError> => {
  const subject =
    kind === "asset" ? { kind, symbol: id } : { kind, id: id.toLowerCase() };
  return PUBLISHED_DATASETS[dataset].subjectKind === kind &&
    Schema.is(SubjectSchema)(subject)
    ? Effect.succeed(subject)
    : Effect.fail(
        new DatasetError({
          kind: "not_found",
          message: `No ${kind} ${id} can have datasets`,
        }),
      );
};

/**
 * Published datasets, looked up by dataset name and subject: list a
 * subject's (or every) publication, read one publication's metadata, and
 * download its current data. No temporary run location is exposed, and
 * deleting the subject or the producing workflow keeps both. Served by the
 * management API (`/api/datasets`) and the app (`/app-api/publications`).
 */
export const createDatasetRoutes = (
  dependencies: DatasetDependencies,
  auth: MiddlewareHandler<{ Bindings: CloudflareBindings }>,
) => {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  app.use("*", auth);

  const run = <A>(
    env: CloudflareBindings,
    program: Effect.Effect<A, DatasetError, DatasetServices>,
  ) => runHttp(program, dependencies.datasetsFor(env));

  app.get(
    "/",
    effectValidator("query", PublicationsQuerySchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const query = c.req.valid("query");
      const publications = await run(
        c.env,
        DatasetPublicationStore.use((store) =>
          store.list({
            ...(query.subjectKind === undefined
              ? {}
              : {
                  subject: {
                    kind: query.subjectKind,
                    ...(query.subjectId === undefined
                      ? {}
                      : { id: query.subjectId }),
                  },
                }),
            ...(query.dataset === undefined ? {} : { dataset: query.dataset }),
          }),
        ),
      );
      return c.json({ publications });
    },
  );

  app.get(
    "/:dataset/:subjectKind/:subjectId",
    effectValidator("param", PublicationParamsSchema),
    async (c) => {
      const { dataset, subjectKind, subjectId } = c.req.valid("param");
      return c.json(
        await run(
          c.env,
          subjectOf(dataset, subjectKind, subjectId).pipe(
            Effect.flatMap((subject) =>
              DatasetPublicationStore.use((store) =>
                store.get(dataset, subject),
              ),
            ),
          ),
        ),
      );
    },
  );

  // The current data, as stored (Parquet). Revalidate with the ETag.
  app.get(
    "/:dataset/:subjectKind/:subjectId/data",
    effectValidator("param", PublicationParamsSchema),
    async (c) => {
      const { dataset, subjectKind, subjectId } = c.req.valid("param");
      const object = await run(
        c.env,
        subjectOf(dataset, subjectKind, subjectId).pipe(
          Effect.flatMap((subject) => currentDatasetData(dataset, subject)),
        ),
      );
      const etag = `"${object.etag}"`;
      const headers = new Headers({
        ETag: etag,
        "Cache-Control": "private, no-cache",
      });
      if (c.req.header("If-None-Match")?.replace(/^W\//u, "") === etag)
        return new Response(null, { status: 304, headers });
      headers.set("Content-Type", object.contentType);
      headers.set("Content-Length", String(object.size));
      return new Response(object.body, { headers });
    },
  );

  return app;
};
