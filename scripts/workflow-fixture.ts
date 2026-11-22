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
 *   portfolio.json         a portfolio with two dated holdings snapshots
 *   asset-runs.json        all asset run outcomes
 *   portfolio-run.json     dependencies, volatility summary and run artifact
 *   portfolio-publication.json  metadata for the published volatility dataset
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

import {
  type PublicationView,
  publishedDatasetKey,
} from "$/datasets/contracts";
import { previousDay } from "$/datetime";
import { FileRunArtifactsLive } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import { FileDatasetObjectStoreLive } from "$/local/published";
import { startPythonService } from "$/local/python";
import { localWorkflowService } from "$/local/runs";
import { makeSqliteD1 } from "$/local/sqlite-d1";
import { localCheckpointer } from "$/local/checkpointer";
import { HttpManagementApiLive, ManagementApi } from "$/management-api/client";
import { HttpPythonOperationsLive } from "$/operations/client";
import type { Portfolio } from "$/portfolios/views";
import { createRoutes } from "$/routes";
import { scheduledWorkflowTick } from "$/workflows/runs/coordinator";
import type { WorkflowRunDetail } from "$/workflows/runs/views";

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
        "Start the runs with an hourly dispatch tick instead of manually",
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
      const fixtures = loadEodhdFixtures(path.resolve(options.fixtures));
      const symbol = options.symbol;
      const secondSymbol = [...fixtures.keys()]
        .sort()
        .find((name) => name !== symbol);
      const symbols =
        secondSymbol === undefined ? [symbol] : [symbol, secondSymbol];
      yield* Console.log("Starting the Python service with uv…");
      const python = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startPythonService({
            artifactRoot: rawBucket,
            processedRoot: processedBucket,
          }),
        ),
        (python) => Effect.promise(() => python.stop()),
      );

      const { db } = makeSqliteD1(path.join(out, "d1.sqlite"));
      const service = localWorkflowService({
        db,
        artifacts: FileRunArtifactsLive(rawBucket),
        sourceFor: fixtureSourceFor(fixtures),
        python: HttpPythonOperationsLive({ fetch }, python.url),
        published: FileDatasetObjectStoreLive(processedBucket),
        platform: { checkpointer: { delayScale: 0 } },
      });
      const routes = createRoutes(service.servicesFor, {
        fetch: () => new Response("No app locally", { status: 404 }),
      });
      const idle = Effect.promise(() => service.platform.idle());

      const log = (line: string) =>
        fs
          .writeFileString(path.join(out, "api.log"), `${line}\n`, {
            flag: "a",
          })
          .pipe(Effect.orDie);
      // The management API in-process, through its real routes and auth.
      const instance = HttpManagementApiLive({
        origin: "http://localhost",
        token: TOKEN,
        fetch: async (request) => routes.fetch(request, env),
        onResponse: log,
      });
      const writeJson = (file: string, value: unknown) =>
        fs.writeFileString(
          path.join(out, file),
          `${JSON.stringify(value, null, 2)}\n`,
        );

      const scenario = Effect.gen(function* () {
        const { request: api } = yield* ManagementApi;
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
        for (const assetSymbol of symbols)
          yield* api("POST", "/assets", {
            symbol: assetSymbol,
            provider: "eodhd",
            backfillStartDate: "2024-01-01",
          });

        const startManual = Effect.gen(function* () {
          const started = new Map<string, string>();
          for (const assetSymbol of symbols) {
            const { id } = yield* api<{ id: string }>("POST", "/runs", {
              workflowId: workflow.id,
              subject: { kind: "asset", symbol: assetSymbol },
              processingDate: options.date,
            });
            started.set(assetSymbol, id);
          }
          return started;
        });
        const dispatch = Effect.gen(function* () {
          const at = `${options.date}T03:00:00Z`;
          const tick = yield* Effect.promise(() =>
            scheduledWorkflowTick(
              service.servicesFor(env),
              env,
              new Date(at),
              localCheckpointer(new Map(), { delayScale: 0 }),
            ),
          );
          if (tick.status !== "dispatched")
            return yield* Effect.fail(new ScriptError("The tick was disabled"));
          const started = new Map<string, string>();
          for (const run of tick.runs) {
            if (run.subject.kind !== "asset") continue;
            yield* log(`tick ${at} -> run ${run.runId} (${run.status})`);
            started.set(run.subject.symbol, run.runId);
          }
          return started;
        });
        const started = yield* options.scheduled ? dispatch : startManual;

        yield* idle;
        const assetRuns: WorkflowRunDetail[] = [];
        for (const assetSymbol of symbols) {
          const id = started.get(assetSymbol);
          if (id === undefined)
            return yield* Effect.fail(
              new ScriptError(`No asset run started for ${assetSymbol}`),
            );
          assetRuns.push(yield* api<WorkflowRunDetail>("GET", `/runs/${id}`));
        }
        const run = assetRuns[0]!;
        yield* writeJson("run.json", run);
        yield* writeJson("asset-runs.json", assetRuns);
        const publication =
          run.status === "completed"
            ? yield* api<unknown>("GET", `/datasets/prices_eod/asset/${symbol}`)
            : undefined;
        let portfolioRun: WorkflowRunDetail | undefined;

        if (publication !== undefined)
          yield* writeJson("publication.json", publication);
        if (assetRuns.every((entry) => entry.status === "completed")) {
          const firstDate = previousDay(
            new Date(`${run.processingDate}T00:00:00Z`),
          );
          const holdingsAt = (primaryWeight: number, secondaryWeight: number) =>
            symbols.map((assetSymbol, index) => ({
              symbol: assetSymbol,
              weight: index === 0 ? primaryWeight : secondaryWeight,
            }));
          const { id } = yield* api<Portfolio>("POST", "/portfolios", {
            name: `${symbol} fixture portfolio`,
            snapshot: {
              holdingsDate: firstDate,
              holdings: holdingsAt(0.75, 0.25),
            },
          });
          yield* api("POST", `/portfolios/${id}/snapshots`, {
            holdingsDate: run.processingDate,
            holdings: holdingsAt(1.25, 0.25),
          });
          yield* writeJson(
            "portfolio.json",
            yield* api<Portfolio>("GET", `/portfolios/${id}`),
          );
          const portfolioWorkflow = yield* api<{ id: string }>(
            "POST",
            "/workflows",
            {
              name: "Portfolio volatility (fixture)",
              scope: "portfolio",
              enabled: true,
              schedule: { hourUtc: 4 },
              steps: [
                {
                  id: "holdings",
                  type: "portfolio-holdings",
                  inputs: {
                    portfolio: { ref: "context.subject" },
                    processingDate: { ref: "context.processingDate" },
                  },
                },
                {
                  id: "dependencies",
                  type: "wait-for-asset-publications",
                  params: { workflowId: workflow.id, timeoutSeconds: 1 },
                  inputs: {
                    holdings: { ref: "steps.holdings.outputs.holdings" },
                    processingDate: { ref: "context.processingDate" },
                  },
                },
                {
                  id: "volatility",
                  type: "calculate-portfolio-volatility",
                  params: { window: 3 },
                  inputs: {
                    holdings: { ref: "steps.holdings.outputs.holdings" },
                    publications: {
                      ref: "steps.dependencies.outputs.publications",
                    },
                    processingDate: { ref: "context.processingDate" },
                  },
                },
                {
                  id: "publish",
                  type: "publish-dataset",
                  params: { dataset: "portfolio_volatility" },
                  inputs: { data: { ref: "steps.volatility.outputs.data" } },
                },
              ],
            },
          );
          const subject = { kind: "portfolio", id };
          yield* api("POST", `/workflows/${portfolioWorkflow.id}/assignments`, {
            subject,
          });
          const startedPortfolio = yield* api<{ id: string }>("POST", "/runs", {
            workflowId: portfolioWorkflow.id,
            subject,
            processingDate: run.processingDate,
          });
          yield* idle;
          portfolioRun = yield* api<WorkflowRunDetail>(
            "GET",
            `/runs/${startedPortfolio.id}`,
          );
          yield* writeJson("portfolio-run.json", portfolioRun);
          if (portfolioRun.status === "completed")
            yield* writeJson(
              "portfolio-publication.json",
              yield* api<PublicationView>(
                "GET",
                `/datasets/portfolio_volatility/portfolio/${id}`,
              ),
            );
        }

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
          yield* Console.log(
            `Portfolio:  ${show(path.join(out, "portfolio.json"))}`,
          );
        }
        if (portfolioRun !== undefined) {
          yield* Console.log(
            `Portfolio run ${portfolioRun.id}: ${portfolioRun.status} (${show(path.join(out, "portfolio-run.json"))})`,
          );
          if (portfolioRun.status === "completed")
            yield* Console.log(
              `Published:  ${show(path.join(processedBucket, publishedDatasetKey("portfolio_volatility", portfolioRun.subject)))}`,
            );
          else yield* Console.error(portfolioRun.error);
        }
        yield* Console.log(`Run record: ${show(path.join(out, "run.json"))}`);
        yield* Console.log(`Database:   ${show(path.join(out, "d1.sqlite"))}`);
        if (run.status !== "completed")
          return yield* Effect.fail(
            new ScriptError(`The run ended ${run.status}`),
          );
        if (portfolioRun?.status !== "completed")
          return yield* Effect.fail(
            new ScriptError(
              `The portfolio run ended ${portfolioRun?.status ?? "without starting"}`,
            ),
          );
      });
      yield* scenario.pipe(Effect.provide(instance));
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Run the asset and portfolio workflows locally against fixture data",
  ),
);

runScript(command);
