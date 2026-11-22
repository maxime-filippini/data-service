/**
 * Trace a portfolio run that waits for an asset run, checkpoint by
 * checkpoint, with every D1 statement and Python call in between:
 *
 *   pnpm workflow:trace [--scenario ready|timeout] [--flaky] [--sql all|writes|none]
 *                       [--symbol AAPL.US] [--date 2024-01-10] [--out DIR]
 *
 * It sets up the same asset workflow as `pnpm workflow:fixture` (download,
 * normalize in Python, publish) and a portfolio workflow that reads its
 * holdings and waits for their prices. Then it plays out what Cloudflare
 * would do:
 *
 * 1. The portfolio run starts before any asset run, so its first check finds
 *    nothing and it goes to sleep.
 * 2. Every sleep is an eviction: the execution stops, a minute of virtual
 *    time passes, and the next execution replays the body from the top.
 *    Stored checkpoints come back without running their bodies.
 * 3. With `--scenario ready` (the default), the asset run happens during the
 *    second sleep, so the third check succeeds. With `--scenario timeout`, it
 *    never happens and the wait fails at its deadline (2.5 minutes here).
 *
 * `--flaky` makes the first Python call fail like a network error, to show a
 * retry inside one checkpoint. Output goes to the terminal and, without
 * colours, to `trace.log` in the output directory (default
 * `.local/workflow-trace`, emptied first) next to the SQLite database.
 *
 * The in-process Workflow binding is a stand-in for Cloudflare: it follows
 * the platform's checkpoint and replay rules, but is not evidence of them.
 */

import { appendFileSync } from "node:fs";

import { Console, Effect, FileSystem, Path } from "effect";
import { Command, Flag } from "effect/cli";

import { FileRunArtifactsLive } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import type { LocalInstance } from "$/local/platform";
import { FileDatasetObjectStoreLive } from "$/local/published";
import { startPythonService } from "$/local/python";
import { localWorkflowService } from "$/local/runs";
import { makeSqliteD1 } from "$/local/sqlite-d1";
import type { LocalStepEvent } from "$/local/steps";
import { HttpManagementApiLive, ManagementApi } from "$/management-api/client";
import { HttpPythonOperationsLive } from "$/operations/client";
import type { Portfolio } from "$/portfolios/views";
import { createRoutes } from "$/routes";

import { runScript, ScriptError } from "./cli";

const TOKEN = "local-trace-token";
const env = {
  MANAGEMENT_API_TOKEN: TOKEN,
} as unknown as CloudflareBindings;

/** The wait's timeout in the timeout scenario: a few checks, then failure. */
const SHORT_TIMEOUT_SECONDS = 150;
/** Wake-ups before giving up on a run that should have finished. */
const MAX_EXECUTIONS = 20;

// ---------------------------------------------------------------------------
// Output

const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string) => (text: string) =>
  colour ? `\u001b[${code}m${text}\u001b[0m` : text;
const style = {
  dim: paint("2"),
  bold: paint("1"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
};
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, "gu");

/** Writes each line to the terminal and, without colours, to a log file. */
const makeTracer = (logFile: string) => (line: string) => {
  process.stdout.write(`${line}\n`);
  appendFileSync(logFile, `${line.replace(ANSI, "")}\n`);
};

const preview = (value: unknown, max = 110) => {
  const json = JSON.stringify(value) ?? "null";
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// ---------------------------------------------------------------------------
// The command

const command = Command.make(
  "workflow-trace",
  {
    out: Flag.String("out").pipe(
      Flag.withDefault(".local/workflow-trace"),
      Flag.withDescription("Output directory, emptied first"),
    ),
    symbol: Flag.String("symbol").pipe(
      Flag.withDefault("AAPL.US"),
      Flag.withDescription("The portfolio's one asset"),
    ),
    date: Flag.String("date").pipe(
      Flag.withDefault("2024-01-10"),
      Flag.withDescription("The runs' processing date"),
    ),
    fixtures: Flag.String("fixtures").pipe(
      Flag.withDefault("fixtures/eodhd"),
      Flag.withDescription("Directory of EODHD responses, one <SYMBOL>.json"),
    ),
    scenario: Flag.Literals("scenario", ["ready", "timeout"]).pipe(
      Flag.withDefault("ready" as const),
      Flag.withDescription(
        "ready: the asset run happens while the portfolio waits; timeout: it never does",
      ),
    ),
    flaky: Flag.Boolean("flaky").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fail the first Python call, to show a retry"),
    ),
    sql: Flag.Literals("sql", ["all", "writes", "none"]).pipe(
      Flag.withDefault("all" as const),
      Flag.withDescription("Which D1 statements to show"),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const out = path.resolve(options.out);
      yield* fs.remove(out, { recursive: true, force: true });
      yield* fs.makeDirectory(out, { recursive: true });
      const trace = makeTracer(path.join(out, "trace.log"));

      // Virtual time: sleeps move it forward instantly. Run records, wait
      // deadlines and publications all read it through the Clock service.
      const start = Date.now();
      let now = start;
      const elapsed = (at = now) => {
        const seconds = Math.round((at - start) / 1000);
        const sign = seconds < 0 ? "-" : "+";
        const abs = Math.abs(seconds);
        return `T${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
      };

      // Who the next D1 statement or Python call belongs to.
      const labels = new Map<string, string>();
      let actor = "setup";
      let tracing = false;
      const say = (line: string) => {
        if (tracing) trace(`${style.dim(elapsed())} ${line}`);
      };
      const who = (label: string) => style.bold(label.padEnd(10));

      // -- D1, traced ------------------------------------------------------
      const { sqlite, db: inner } = makeSqliteD1(path.join(out, "d1.sqlite"));
      const showSql = (
        sql: string,
        values: readonly unknown[],
        batch = false,
      ) => {
        const compact = sql.replace(/\s+/gu, " ").trim();
        const write = /^(INSERT|UPDATE|DELETE)/iu.test(compact);
        if (options.sql === "none" || (options.sql === "writes" && !write))
          return;
        const shown = values
          .map((value) =>
            typeof value === "string" ? `'${clip(value, 28)}'` : String(value),
          )
          .join(", ");
        say(
          `${who(actor)}   ${write ? style.blue("D1 write") : style.dim("D1 read ")}${batch ? style.dim(" (batch)") : ""} ${clip(compact, write ? 150 : 110)}${shown === "" ? "" : style.dim(`  [${clip(shown, 90)}]`)}`,
        );
      };
      type Statement = {
        readonly inner: D1PreparedStatement;
        readonly sql: string;
        readonly values: readonly unknown[];
      };
      const wrap = (
        statement: D1PreparedStatement,
        sql: string,
        values: readonly unknown[] = [],
      ) => {
        const traced: Statement & Record<string, unknown> = {
          inner: statement,
          sql,
          values,
          bind: (...bound: unknown[]) =>
            wrap(statement.bind(...bound), sql, bound),
          run: () => (showSql(sql, values), statement.run()),
          all: () => (showSql(sql, values), statement.all()),
          first: (column?: string) => (
            showSql(sql, values),
            statement.first(column as never)
          ),
          raw: () => (showSql(sql, values), statement.raw()),
        };
        return traced;
      };
      const db = {
        prepare: (sql: string) => wrap(inner.prepare(sql), sql),
        batch: (statements: Statement[]) => {
          for (const statement of statements)
            showSql(statement.sql, statement.values, true);
          return inner.batch(statements.map(({ inner }) => inner));
        },
        exec: (sql: string) => inner.exec(sql),
      } as unknown as D1Database;

      // -- Python, traced --------------------------------------------------
      const rawBucket = path.join(out, "r2", "raw-market-data");
      const processedBucket = path.join(out, "r2", "processed-market-data");
      yield* Console.log("Starting the Python service with uv…");
      const python = yield* Effect.acquireRelease(
        Effect.promise(() => startPythonService({ artifactRoot: rawBucket })),
        (python) => Effect.promise(() => python.stop()),
      );
      let failNextPython = options.flaky;
      const pythonFetch = async (url: string, init: RequestInit) => {
        const operation = new URL(url).pathname.replace("/operations/", "");
        if (failNextPython) {
          failNextPython = false;
          say(
            `${who(actor)}   ${style.red("Python  ")} ${operation} → connection refused (--flaky)`,
          );
          throw new TypeError("fetch failed (simulated by --flaky)");
        }
        const began = Date.now();
        const response = await fetch(url, init);
        say(
          `${who(actor)}   ${style.cyan("Python  ")} ${operation} → ${response.status} ${style.dim(`(${Date.now() - began} ms real)`)}`,
        );
        return response;
      };

      // -- Checkpoint events ----------------------------------------------
      const evicted = new Set<string>();
      const onEvent = (
        instance: LocalInstance,
        event: LocalStepEvent | { readonly type: "execution" },
      ) => {
        const label = labels.get(instance.id) ?? instance.id.slice(0, 8);
        actor = label;
        switch (event.type) {
          case "execution":
            trace("");
            trace(
              style.bold(
                `── ${label} · execution #${instance.executions}${instance.executions > 1 ? ": Cloudflare runs the body again from the top" : ""} ──`,
              ),
            );
            return;
          case "replayed":
            return say(
              `${who(label)} ${style.dim(`↺ replayed  ${event.name}  → stored result, body skipped`)}`,
            );
          case "attempt":
            return say(
              `${who(label)} ${style.yellow("▶ running")}   ${event.name}${event.attempt > 1 ? style.yellow(` (attempt ${event.attempt})`) : ""}`,
            );
          case "failed":
            return say(
              `${who(label)} ${style.red(`✗ attempt ${event.attempt} failed`)}: ${clip(event.error, 120)} ${event.retrying ? style.dim("→ retried inside the same checkpoint") : style.red("→ no retry")}`,
            );
          case "stored":
            return say(
              `${who(label)} ${style.green("■ stored")}    ${event.name} = ${style.dim(preview(event.value))}`,
            );
          case "sleep":
            return say(
              `${who(label)} ${style.magenta("⏾ sleeping")}  ${event.name} until ${elapsed(event.until)}`,
            );
          case "interrupted":
            return say(
              `${who(label)} ${style.magenta(`✂ evicted before "${event.name}"`)}: the instance hibernates and nothing runs until it wakes`,
            );
        }
      };

      const service = localWorkflowService({
        db,
        artifacts: FileRunArtifactsLive(rawBucket),
        sourceFor: fixtureSourceFor(
          loadEodhdFixtures(path.resolve(options.fixtures)),
        ),
        python: HttpPythonOperationsLive({ fetch: pythonFetch }, python.url),
        published: FileDatasetObjectStoreLive(processedBucket),
        now: () => now,
        platform: {
          autoStart: false,
          // Each sleep is an eviction: stop before it once, so the next
          // execution replays everything stored so far and then sleeps.
          interruptBefore: (instance, step) => {
            if (!step.startsWith("wait ")) return false;
            const key = `${instance.id} ${step}`;
            if (evicted.has(key)) return false;
            evicted.add(key);
            return true;
          },
          onEvent,
          steps: {
            delayScale: 0,
            sleepUntil: async (timestamp) => {
              now = Math.max(now, timestamp);
            },
          },
        },
      });
      const { platform } = service;

      const routes = createRoutes(service.dependencies, {
        fetch: () => new Response("No app locally", { status: 404 }),
      });
      const managementApi = HttpManagementApiLive({
        origin: "http://localhost",
        token: TOKEN,
        fetch: async (request) => routes.fetch(request, env),
        onResponse: (line) =>
          Effect.sync(() =>
            say(`${who("api")}   ${style.dim(`HTTP ${line}`)}`),
          ),
      });

      // -- D1 snapshots ----------------------------------------------------
      const showRun = (runId: string) => {
        const run = sqlite
          .prepare(`SELECT status, error FROM workflow_runs WHERE run_id = ?`)
          .get(runId) as { status: string; error: string | null } | undefined;
        const steps = sqlite
          .prepare(
            `SELECT step_id, status, attempts, error, waiting_json
             FROM workflow_run_steps WHERE run_id = ? ORDER BY position`,
          )
          .all(runId) as {
          step_id: string;
          status: string;
          attempts: number;
          error: string | null;
          waiting_json: string | null;
        }[];
        const label = labels.get(runId) ?? runId;
        trace(
          `  ${style.bold("D1 now")} ${label}: workflow_runs.status = ${style.bold(run?.status ?? "?")}${run?.error ? style.red(`, error = ${clip(run.error, 100)}`) : ""}`,
        );
        for (const step of steps)
          trace(
            `           run_steps[${step.step_id}] = ${step.status}, attempts ${step.attempts}` +
              (step.waiting_json === null
                ? ""
                : style.dim(`, waiting_json ${clip(step.waiting_json, 120)}`)) +
              (step.error === null
                ? ""
                : style.red(`, error ${clip(step.error, 80)}`)),
          );
        const checkpoints = platform.instances.get(runId)?.checkpoints;
        if (checkpoints !== undefined)
          trace(
            `  ${style.bold("Stored")}  ${checkpoints.size} checkpoints: ${style.dim([...checkpoints.keys()].join(" · "))}`,
          );
      };

      const phase = (title: string, detail?: string) =>
        Effect.sync(() => {
          trace("");
          trace(style.bold(style.cyan(`━━ ${title}`)));
          if (detail !== undefined) trace(style.dim(`   ${detail}`));
        });

      const settle = Effect.promise(() => platform.idle());
      const finished = (id: string) => {
        const status = platform.instances.get(id)?.status;
        return status === "complete" || status === "errored";
      };

      const scenario = Effect.gen(function* () {
        const { request: api } = yield* ManagementApi;
        const symbol = options.symbol;

        // -- Setup (not traced) --------------------------------------------
        const assetWorkflow = yield* api<{ id: string }>("POST", "/workflows", {
          name: "Daily asset prices (trace)",
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
        yield* api("PUT", `/workflow-defaults/asset/${assetWorkflow.id}`);
        yield* api("POST", "/assets", {
          symbol,
          provider: "eodhd",
          backfillStartDate: "2024-01-01",
        });
        const portfolio = yield* api<Portfolio>("POST", "/portfolios", {
          name: `${symbol} trace portfolio`,
          snapshot: {
            holdingsDate: options.date,
            holdings: [{ symbol, weight: 1 }],
          },
        });
        const timeoutSeconds =
          options.scenario === "timeout" ? SHORT_TIMEOUT_SECONDS : undefined;
        const portfolioWorkflow = yield* api<{ id: string }>(
          "POST",
          "/workflows",
          {
            name: "Portfolio price dependencies (trace)",
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
                params: {
                  workflowId: assetWorkflow.id,
                  ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
                },
                inputs: {
                  holdings: { ref: "steps.holdings.outputs.holdings" },
                  processingDate: { ref: "context.processingDate" },
                },
              },
            ],
          },
        );
        const portfolioSubject = { kind: "portfolio", id: portfolio.id };
        yield* api("POST", `/workflows/${portfolioWorkflow.id}/assignments`, {
          subject: portfolioSubject,
        });

        yield* Console.log(
          `Set up asset workflow ${assetWorkflow.id}, portfolio ${portfolio.id} holding ${symbol}, and its workflow (wait timeout ${timeoutSeconds ?? 2 * 60 * 60} s).`,
        );
        tracing = true;
        actor = "api";

        // -- 1. The portfolio run starts first -------------------------------
        yield* phase(
          "1. Start the portfolio run before any asset run",
          "POST /runs claims the assignment and creates the Workflow instance; then the instance starts.",
        );
        const portfolioRun = yield* api<{ id: string }>("POST", "/runs", {
          workflowId: portfolioWorkflow.id,
          subject: portfolioSubject,
          processingDate: options.date,
        });
        labels.set(portfolioRun.id, "portfolio");
        platform.start(portfolioRun.id);
        yield* settle;
        showRun(portfolioRun.id);

        // -- 2+. Wake-ups ----------------------------------------------------
        let assetRunId: string | undefined;
        for (let wake = 1; !finished(portfolioRun.id); wake += 1) {
          if (wake > MAX_EXECUTIONS)
            return yield* Effect.fail(
              new ScriptError(
                `The portfolio run did not finish after ${MAX_EXECUTIONS} wake-ups`,
              ),
            );
          if (options.scenario === "ready" && wake === 2) {
            actor = "api";
            yield* phase(
              "Meanwhile: the asset run happens",
              "A separate Workflow instance. It never talks to the portfolio run; it only writes D1 rows and R2 objects.",
            );
            const assetRun = yield* api<{ id: string }>("POST", "/runs", {
              workflowId: assetWorkflow.id,
              subject: { kind: "asset", symbol },
              processingDate: options.date,
            });
            assetRunId = assetRun.id;
            labels.set(assetRun.id, "asset");
            platform.start(assetRun.id);
            yield* settle;
            showRun(assetRun.id);
          }
          yield* phase(
            `${wake + 1}. Wake-up ${wake}: the sleep ends and Cloudflare replays the portfolio run`,
          );
          platform.replay(portfolioRun.id);
          yield* settle;
          showRun(portfolioRun.id);
        }

        // -- Summary ---------------------------------------------------------
        const instance = platform.instances.get(portfolioRun.id)!;
        trace("");
        trace(
          style.bold(
            `Portfolio run ${instance.status === "complete" ? style.green("completed") : style.red("failed")} after ${instance.executions} executions and ${elapsed()} of virtual time.`,
          ),
        );
        if (assetRunId !== undefined)
          trace(`Asset run: ${labels.get(assetRunId)} ${assetRunId}`);
        trace(
          `Trace:    ${path.relative(".", path.join(out, "trace.log")) || "."}`,
        );
        trace(`Database: ${path.relative(".", path.join(out, "d1.sqlite"))}`);
        tracing = false;
      });

      yield* scenario.pipe(Effect.provide(managementApi));
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Trace a portfolio run waiting for an asset run, checkpoint by checkpoint",
  ),
);

runScript(command);
