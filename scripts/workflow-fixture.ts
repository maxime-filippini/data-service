/**
 * Run the asset prices workflow (download, normalize in Python, publish)
 * locally against fixture data, through the same API routes, executor, step
 * implementations and Python operations as the Worker:
 *
 *   pnpm workflow:fixture [--out DIR] [--symbol AAPL.US] [--date 2024-01-10]
 *                         [--scheduled]
 *
 * It starts the real Python service with uv on a free localhost port, then
 * through the management API creates a workflow definition, makes it the
 * asset default and creates the asset (which assigns it). It then starts a
 * manual run for the date or, with `--scheduled`, runs one hourly dispatch
 * tick (WORKFLOW_DISPATCH on) an hour after the definition's 02:00 UTC
 * occurrence on that date. It waits for the run and leaves everything to
 * inspect in the output directory (default `.local/workflow-fixture`,
 * emptied first):
 *
 *   d1.sqlite              the local D1 database (real migrations)
 *   r2/raw-market-data/runs/<runId>/download/raw.json         raw artifact
 *   r2/raw-market-data/runs/<runId>/normalize/prices.parquet  Python's output
 *   r2/processed-market-data/dataset=prices_eod/symbol=<SYMBOL>/data.parquet
 *                          the published dataset, at its stable location
 *   run.json               the run and its step outcomes (API view)
 *   publication.json       the publication's metadata (API view)
 *   api.log                every API request and response status
 *
 * Both languages share `r2/raw-market-data/` as the run artifact store.
 * Provider responses come from `fixtures/eodhd/<SYMBOL>.json`, served to the
 * real EODHD adapter, so no credentials or network are needed. Retries
 * happen without waiting. The in-process Workflow binding is a stand-in: it
 * is not evidence of Cloudflare's durability.
 */

import { Console, Effect, FileSystem, Path } from "effect";
import { Command, Flag } from "effect/cli";

import { publishedDatasetKey } from "$/datasets/contracts";
import { FileRunArtifactsLive } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import { FileDatasetObjectStoreLive } from "$/local/published";
import { startPythonService } from "$/local/python";
import { localWorkflowService } from "$/local/runs";
import { makeSqliteD1 } from "$/local/sqlite-d1";
import { localSteps } from "$/local/steps";
import { HttpPythonOperationsLive } from "$/operations/client";
import { createRoutes } from "$/routes";
import type { WorkflowRunDetail } from "$/workflows/runs/contracts";
import { scheduledWorkflowTick } from "$/workflows/runs/dispatch";

import { runScript, ScriptError } from "./cli";

// A local-only token: the management API's authentication stays in place.
const TOKEN = "local-fixture-token";
const env = {
  MANAGEMENT_API_TOKEN: TOKEN,
  WORKFLOW_DISPATCH: "on",
} as unknown as CloudflareBindings;

const text = (name: string, fallback: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDefault(fallback),
    Flag.withDescription(description),
  );

const command = Command.make(
  "workflow-fixture",
  {
    out: text(
      "out",
      ".local/workflow-fixture",
      "Output directory, emptied first",
    ),
    symbol: text("symbol", "AAPL.US", "The asset to run the workflow for"),
    date: text("date", "2024-01-10", "The run's processing date"),
    fixtures: text(
      "fixtures",
      "fixtures/eodhd",
      "Directory of EODHD responses, one <SYMBOL>.json per asset",
    ),
    scheduled: Flag.Boolean("scheduled").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Start the run with an hourly dispatch tick instead of manually",
      ),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const out = path.resolve(options.out);
      yield* fs.remove(out, { recursive: true, force: true });
      yield* fs.makeDirectory(out, { recursive: true });

      const rawBucket = path.join(out, "r2", "raw-market-data");
      const processedBucket = path.join(out, "r2", "processed-market-data");
      yield* Console.log("Starting the Python service with uv…");
      const python = yield* Effect.acquireRelease(
        Effect.promise(() => startPythonService({ artifactRoot: rawBucket })),
        (python) => Effect.promise(() => python.stop()),
      );

      const { db } = makeSqliteD1(path.join(out, "d1.sqlite"));
      const service = localWorkflowService({
        db,
        artifacts: FileRunArtifactsLive(rawBucket),
        sourceFor: fixtureSourceFor(
          loadEodhdFixtures(path.resolve(options.fixtures)),
        ),
        python: HttpPythonOperationsLive({ fetch }, python.url),
        published: FileDatasetObjectStoreLive(processedBucket),
        platform: { steps: { delayScale: 0 } },
      });
      const routes = createRoutes(service.dependencies, {
        fetch: () => new Response("No app locally", { status: 404 }),
      });

      const api = <T>(method: string, route: string, body?: unknown) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(async () =>
            routes.request(
              `http://localhost/api${route}`,
              {
                method,
                headers: {
                  Authorization: `Bearer ${TOKEN}`,
                  ...(body === undefined
                    ? {}
                    : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              },
              env,
            ),
          );
          const responseText = yield* Effect.promise(() => response.text());
          yield* fs.writeFileString(
            path.join(out, "api.log"),
            `${method} /api${route} -> ${response.status}\n`,
            { flag: "a" },
          );
          if (!response.ok)
            return yield* Effect.fail(
              new ScriptError(
                `${method} /api${route} -> ${response.status}: ${responseText}`,
              ),
            );
          return JSON.parse(responseText) as T;
        });
      const writeJson = (file: string, value: unknown) =>
        fs.writeFileString(
          path.join(out, file),
          `${JSON.stringify(value, null, 2)}\n`,
        );

      const symbol = options.symbol;
      const workflow = yield* api<{ id: string }>("POST", "/workflows", {
        name: "Daily asset prices (fixture)",
        scope: "asset",
        enabled: true,
        schedule: { hourUtc: 2 },
        steps: [
          {
            id: "download",
            type: "download-prices",
            inputs: {
              asset: { ref: "context.subject" },
              throughDate: { ref: "context.processingDate" },
            },
          },
          {
            id: "normalize",
            type: "normalize-prices",
            inputs: { raw: { ref: "steps.download.outputs.raw" } },
          },
          {
            id: "publish",
            type: "publish-dataset",
            params: { dataset: "prices_eod" },
            inputs: { data: { ref: "steps.normalize.outputs.prices" } },
          },
        ],
      });
      // The default assigns the definition to the asset when it is created.
      yield* api("PUT", `/workflow-defaults/asset/${workflow.id}`);
      yield* api("POST", "/assets", {
        symbol,
        provider: "eodhd",
        backfillStartDate: "2024-01-01",
      });

      const startManual = api<{ id: string }>("POST", "/runs", {
        workflowId: workflow.id,
        subject: { kind: "asset", symbol },
        processingDate: options.date,
      });
      const dispatch = Effect.gen(function* () {
        const at = `${options.date}T03:00:00Z`;
        const tick = yield* Effect.promise(() =>
          scheduledWorkflowTick(
            service.dependencies,
            env,
            new Date(at),
            localSteps(new Map(), { delayScale: 0 }),
          ),
        );
        const run = tick.status === "dispatched" ? tick.runs[0] : undefined;
        if (run === undefined)
          return yield* Effect.fail(
            new ScriptError("The tick dispatched no run"),
          );
        yield* fs.writeFileString(
          path.join(out, "api.log"),
          `tick ${at} -> run ${run.runId} (${run.status})\n`,
          { flag: "a" },
        );
        return { id: run.runId };
      });
      const started = yield* options.scheduled ? dispatch : startManual;

      yield* Effect.promise(() => service.platform.idle());
      const run = yield* api<WorkflowRunDetail>("GET", `/runs/${started.id}`);
      yield* writeJson("run.json", run);
      const publication =
        run.status === "completed"
          ? yield* api<unknown>("GET", `/datasets/prices_eod/asset/${symbol}`)
          : undefined;
      if (publication !== undefined)
        yield* writeJson("publication.json", publication);

      const show = (file: string) => path.relative(".", file) || ".";
      yield* Console.log(`Run ${run.id}: ${run.status}`);
      for (const step of run.steps)
        yield* Console.log(
          `  ${step.position}. ${step.id} (${step.type}): ${step.status}` +
            (step.error === null ? "" : ` - ${step.error}`),
        );
      for (const step of run.steps)
        for (const value of Object.values(step.outputs ?? {}))
          if (typeof value === "object" && value !== null && "id" in value)
            yield* Console.log(
              `  artifact: ${show(path.join(rawBucket, String(value.id)))}`,
            );
      if (publication !== undefined) {
        yield* Console.log(
          `Published:  ${show(path.join(processedBucket, publishedDatasetKey("prices_eod", { kind: "asset", symbol })))}`,
        );
        yield* Console.log(
          `Metadata:   ${show(path.join(out, "publication.json"))}`,
        );
      }
      yield* Console.log(`Run record: ${show(path.join(out, "run.json"))}`);
      yield* Console.log(`Database:   ${show(path.join(out, "d1.sqlite"))}`);
      if (run.status !== "completed")
        return yield* Effect.fail(
          new ScriptError(`The run ended ${run.status}`),
        );
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Run the asset prices workflow locally against fixture data",
  ),
);

runScript(command);
