/**
 * Drive the deployed smoke Worker through scheduled dispatch, a lost
 * create/lookup, a paused and resumed wait, retried Python and metadata
 * faults, a timeout, a rerun and terminal and exhausted failures, checking
 * the app's records against Cloudflare's own instance logs:
 *
 *   node --import tsx scripts/cloudflare-smoke/run.ts <dir> <worker-url>
 *
 * Evidence is written to <dir>/evidence-<suffix>/.
 */

import assert from "node:assert/strict";

import { importJWK, SignJWT, type JWK } from "jose";
import { Clock, Console, Crypto, Effect, FileSystem, Path } from "effect";
import { Argument, Command } from "effect/cli";

import type { PublicationView } from "$/datasets/contracts";
import type {
  WorkflowRunDetail,
  WorkflowRunStatus,
} from "$/workflows/runs/contracts";
import type { TickReport } from "$/workflows/runs/dispatch";

import { runProcess, runScript, ScriptError } from "../cli";

const processingDate = "2024-01-05";
const scheduledAt = `${processingDate}T05:00:00Z`;

interface InstanceView {
  readonly status: { status: string };
  readonly faults: readonly { point: string; detail: unknown }[];
}

interface PlatformLog {
  readonly status: string;
  readonly steps: readonly {
    name?: string;
    type: string;
    output?: string;
    attempts?: readonly { success: boolean; error?: { message: string } }[];
  }[];
}

const publishedSteps = [
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
];

const portfolioSteps = (
  workflowId: string,
  timeoutSeconds: number,
  publishId: string,
) => [
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
    params: { workflowId, timeoutSeconds },
    inputs: {
      assets: { ref: "steps.holdings.outputs.assets" },
      processingDate: { ref: "context.processingDate" },
    },
  },
  {
    id: "volatility",
    type: "calculate-portfolio-volatility",
    params: { window: 3 },
    inputs: {
      holdings: { ref: "steps.holdings.outputs.holdings" },
      holdingsDate: { ref: "steps.holdings.outputs.holdingsDate" },
      publications: { ref: "steps.dependencies.outputs.publications" },
      processingDate: { ref: "context.processingDate" },
    },
  },
  {
    id: publishId,
    type: "publish-dataset",
    params: { dataset: "portfolio_volatility" },
    inputs: { data: { ref: "steps.volatility.outputs.data" } },
  },
];

function platformStep(log: PlatformLog, name: string) {
  const found = log.steps.find((entry) => entry.name === `${name}-1`);
  assert.ok(found, `Cloudflare log has no step named ${name}`);
  return found;
}

function step(run: WorkflowRunDetail, id: string) {
  const outcome = run.steps.find((entry) => entry.id === id);
  assert.ok(outcome, `Run ${run.id} has no outcome for ${id}`);
  return outcome;
}

const command = Command.make(
  "run",
  {
    directory: Argument.String("private-directory").pipe(
      Argument.withDescription("The directory prepare.ts printed"),
    ),
    workerUrl: Argument.String("smoke-worker-url").pipe(
      Argument.withDescription("The deployed smoke Worker's workers.dev URL"),
    ),
  },
  ({ directory, workerUrl }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;

      const readJson = <T>(file: string) =>
        fs
          .readFileString(path.resolve(directory, file))
          .pipe(Effect.map((text) => JSON.parse(text) as T));

      const { resource, fixtureSymbolPrefix } = yield* readJson<{
        resource: string;
        fixtureSymbolPrefix: string;
      }>("resources.json");
      const base = new URL(workerUrl);
      assert.equal(base.protocol, "https:");
      assert.ok(
        base.hostname.startsWith(`${resource}.`) &&
          base.hostname.endsWith(".workers.dev"),
      );
      const secrets = yield* readJson<Record<string, string>>("secrets.json");
      const accessJwk = yield* readJson<JWK>("access-private.jwk.json");
      const accessToken = yield* Effect.promise(async () =>
        new SignJWT({ email: secrets.DASHBOARD_ALLOWED_EMAILS })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer(`https://${secrets.ACCESS_TEAM_DOMAIN}`)
          .setAudience(secrets.ACCESS_AUD!)
          .setExpirationTime("30m")
          .sign(await importJWK(accessJwk, "RS256")),
      );
      const suffix = Buffer.from(yield* crypto.randomBytes(4))
        .toString("hex")
        .toUpperCase();
      const fixtureSymbol = (role: string) =>
        `${fixtureSymbolPrefix}-${suffix}-${role}.US`;
      const symbols = [fixtureSymbol("A"), fixtureSymbol("B")];
      const evidenceDir = path.resolve(directory, `evidence-${suffix}`);
      yield* fs.makeDirectory(evidenceDir, { mode: 0o700 });

      const evidence = (name: string, value: unknown) =>
        fs
          .writeFileString(
            path.resolve(evidenceDir, `${name}.json`),
            JSON.stringify(value, null, 2) + "\n",
            { mode: 0o600 },
          )
          .pipe(Effect.andThen(Console.log(name)));

      const request = (method: string, route: string, body?: unknown) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(new URL(route, base), {
                method,
                headers: {
                  Authorization: `Bearer ${secrets.MANAGEMENT_API_TOKEN}`,
                  "Cf-Access-Jwt-Assertion": accessToken,
                  ...(body === undefined
                    ? {}
                    : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            catch: (error) =>
              new ScriptError(`${method} ${route} failed: ${String(error)}`),
          });
          if (!response.ok) {
            const text = yield* Effect.promise(() => response.text());
            return yield* Effect.fail(
              new ScriptError(
                `${method} ${route} returned ${response.status}: ${text.slice(0, 1500)}`,
              ),
            );
          }
          return response;
        });
      const json = <T>(response: Response) =>
        Effect.promise(() => response.json() as Promise<T>);
      const api = <T>(method: string, route: string, body?: unknown) =>
        request(method, `/api${route}`, body).pipe(Effect.flatMap(json<T>));
      const page = (route: string) =>
        request("GET", route).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.text())),
        );

      /** Re-read `get` every 1.5 s until `ready`, for up to six minutes. */
      const poll = <T>(
        name: string,
        get: Effect.Effect<T, ScriptError>,
        ready: (value: T) => boolean,
      ) =>
        Effect.gen(function* () {
          const expires = (yield* Clock.currentTimeMillis) + 6 * 60_000;
          let value = yield* get;
          while (!ready(value)) {
            if ((yield* Clock.currentTimeMillis) >= expires)
              return yield* Effect.fail(
                new ScriptError(
                  `Timed out waiting for ${name}; last response: ${JSON.stringify(value)}`,
                ),
              );
            yield* Effect.sleep("1500 millis");
            value = yield* get;
          }
          return value;
        });

      const runAt = (id: string, status: WorkflowRunStatus) =>
        poll(
          `run ${id} to be ${status}`,
          api<WorkflowRunDetail>("GET", `/runs/${id}`),
          (run) => {
            if (run.status === status) return true;
            if (["completed", "failed", "skipped"].includes(run.status))
              throw new Error(
                `Run ${id} ended ${run.status}, expected ${status}: ${run.error}`,
              );
            return false;
          },
        );

      const tick = (fault?: string) =>
        Effect.gen(function* () {
          const result = yield* request("POST", "/__smoke/tick", {
            at: scheduledAt,
            fault,
          }).pipe(Effect.flatMap(json<TickReport>));
          assert.equal(result.status, "dispatched");
          assert.deepEqual(result.failures, []);
          return result;
        });

      const instance = (id: string) =>
        request("GET", `/__smoke/instances/${id}`).pipe(
          Effect.flatMap(json<InstanceView>),
        );

      const platformCommand = (
        action: "describe" | "pause" | "resume",
        id: string,
      ) =>
        runProcess(
          "pnpm",
          [
            "exec",
            "wrangler",
            "workflows",
            "instances",
            action,
            resource,
            id,
            ...(action === "describe" ? ["--json"] : []),
            "--config",
            path.resolve(directory, "wrangler.smoke.json"),
          ],
          { timeout: "60 seconds" },
        );

      const platformLogs = (id: string) =>
        platformCommand("describe", id).pipe(
          Effect.map((output) => JSON.parse(output) as PlatformLog),
        );

      const newAsset = (symbol: string) =>
        api("POST", "/assets", {
          symbol,
          provider: "eodhd",
          backfillStartDate: "2024-01-01",
        }).pipe(Effect.as({ kind: "asset", symbol }));

      const verifyParquet = (
        route: string,
        name: string,
        expectedSize: number,
      ) =>
        Effect.gen(function* () {
          const response = yield* request("GET", route);
          const data = Buffer.from(
            yield* Effect.promise(() => response.arrayBuffer()),
          );
          assert.equal(data.length, expectedSize);
          assert.equal(data.subarray(0, 4).toString(), "PAR1");
          assert.equal(data.subarray(-4).toString(), "PAR1");
          const target = path.resolve(evidenceDir, name);
          yield* fs.writeFile(target, data, { mode: 0o600 });
          return target;
        });

      const assetWorkflow = yield* api<{ id: string }>("POST", "/workflows", {
        name: `Smoke prices ${suffix}`,
        scope: "asset",
        enabled: true,
        schedule: { hourUtc: 2 },
        steps: publishedSteps,
      });
      const assets = yield* Effect.forEach(symbols, newAsset, {
        concurrency: "unbounded",
      });
      const portfolio = yield* api<{ id: string }>("POST", "/portfolios", {
        name: `Smoke portfolio ${suffix}`,
        snapshot: {
          holdingsDate: "2024-01-04",
          holdings: symbols.map((symbol, index) => ({
            symbol,
            weight: index === 0 ? 0.25 : 0.75,
          })),
        },
      });
      yield* api("POST", `/portfolios/${portfolio.id}/snapshots`, {
        holdingsDate: processingDate,
        holdings: symbols.map((symbol, index) => ({
          symbol,
          weight: index === 0 ? 0.25 : 1.25,
        })),
      });
      const spec = (timeout: number, publishId: string) => ({
        name: `Smoke portfolio volatility ${suffix}`,
        scope: "portfolio",
        enabled: true,
        schedule: { hourUtc: 4 },
        steps: portfolioSteps(assetWorkflow.id, timeout, publishId),
      });
      const portfolioWorkflow = yield* api<{ id: string }>(
        "POST",
        "/workflows",
        spec(300, "publish"),
      );
      const subject = { kind: "portfolio", id: portfolio.id };
      yield* api("POST", `/workflows/${portfolioWorkflow.id}/assignments`, {
        subject,
      });

      const firstTick = yield* tick("lose-create-and-lookup");
      assert.equal(firstTick.runs.length, 1);
      const portfolioRun = firstTick.runs[0]!;
      assert.equal(portfolioRun.workflowId, portfolioWorkflow.id);
      assert.equal(
        portfolioRun.scheduledFor,
        `${processingDate}T04:00:00.000Z`,
      );
      const runId = portfolioRun.runId;
      const waiting = yield* runAt(runId, "waiting");
      const deadline = step(waiting, "dependencies").waiting?.deadline;
      assert.ok(deadline);
      assert.deepEqual(
        step(waiting, "dependencies").waiting?.missing.map(
          ({ symbol }) => symbol,
        ),
        symbols,
      );
      const waitingPage = yield* page(`/workflow-runs/${runId}`);
      assert.match(
        waitingPage,
        /No successful run from the upstream workflow/u,
      );
      const secondTick = yield* tick("lose-lookup");
      assert.deepEqual(secondTick.runs, []);
      assert.ok(secondTick.reconciled.kept >= 1);
      assert.equal(secondTick.reconciled.failed, 0);
      const waitingRun = yield* api<WorkflowRunDetail>("GET", `/runs/${runId}`);
      assert.equal(waitingRun.status, "waiting");
      assert.equal(
        step(waitingRun, "dependencies").waiting?.deadline,
        deadline,
      );
      const waitingLog = yield* platformLogs(runId);
      assert.equal(
        platformStep(waitingLog, "start wait dependencies").output,
        deadline,
      );
      yield* evidence("waiting", {
        firstTick,
        secondTick,
        run: waitingRun,
        instance: yield* instance(runId),
        platform: waitingLog,
      });
      yield* platformCommand("pause", runId);
      yield* poll(
        "paused Cloudflare instance",
        instance(runId),
        (entry) => entry.status.status === "paused",
      );
      assert.equal(
        step(
          yield* api<WorkflowRunDetail>("GET", `/runs/${runId}`),
          "dependencies",
        ).waiting?.deadline,
        deadline,
      );

      yield* api(
        "PUT",
        `/workflows/${portfolioWorkflow.id}`,
        spec(5, "publish-updated"),
      );
      for (const asset of assets)
        yield* api("POST", `/workflows/${assetWorkflow.id}/assignments`, {
          subject: asset,
        });
      const upstreamTick = yield* tick();
      assert.equal(upstreamTick.runs.length, 2);
      const upstream = yield* Effect.forEach(
        upstreamTick.runs,
        ({ runId }) => runAt(runId, "completed"),
        { concurrency: "unbounded" },
      );
      assert.ok(
        upstream.every(
          (run) =>
            run.trigger === "schedule" && run.processingDate === processingDate,
        ),
      );
      yield* evidence("upstream", { tick: upstreamTick, runs: upstream });
      assert.deepEqual((yield* tick()).runs, []);
      yield* platformCommand("resume", runId);

      const finished = yield* runAt(runId, "completed");
      assert.deepEqual(
        finished.steps.map(({ id }) => id),
        ["holdings", "dependencies", "volatility", "publish"],
      );
      assert.equal(step(finished, "holdings").attempts, 1);
      assert.equal(
        step(finished, "holdings").startedAt,
        step(waiting, "holdings").startedAt,
      );
      assert.equal(step(finished, "volatility").attempts, 2);
      assert.equal(step(finished, "publish").attempts, 2);
      const completedLog = yield* platformLogs(runId);
      const completedInstance = yield* poll(
        "completed Cloudflare instance",
        instance(runId),
        (entry) => entry.status.status === "complete",
      );
      assert.equal(
        platformStep(completedLog, "wait dependencies 1").type,
        "sleep",
      );
      assert.deepEqual(
        platformStep(completedLog, "check dependencies 2").attempts?.map(
          ({ success }) => success,
        ),
        [true],
      );
      assert.deepEqual(
        platformStep(completedLog, "step holdings"),
        platformStep(waitingLog, "step holdings"),
      );
      assert.equal(
        platformStep(completedLog, "start wait dependencies").output,
        deadline,
      );
      for (const id of ["volatility", "publish"])
        assert.deepEqual(
          platformStep(completedLog, `step ${id}`).attempts?.map(
            ({ success }) => success,
          ),
          [false, true],
        );

      const pythonFault = completedInstance.faults.find(
        ({ point }) => point === "python-response",
      );
      assert.deepEqual(
        pythonFault?.detail,
        step(finished, "volatility").outputs,
      );
      const calc = step(finished, "volatility").outputs?.summary as {
        volatility: number;
        observations: number;
      };
      assert.equal(calc.observations, 3);
      assert.ok(Math.abs(calc.volatility - 0.16655193949753938) < 1e-12);

      const dataset = `/datasets/portfolio_volatility/portfolio/${portfolio.id}`;
      const publication = yield* api<PublicationView>("GET", dataset);
      assert.equal(publication.producer.runId, runId);
      const metadataFault = completedInstance.faults.find(
        ({ point }) => point === "publication-metadata",
      );
      assert.deepEqual(metadataFault?.detail, {
        etag: publication.etag,
        size: publication.size,
      });
      const parquet = yield* verifyParquet(
        `/api${dataset}/data`,
        "portfolio-volatility.parquet",
        publication.size,
      );
      yield* runProcess(
        "uv",
        [
          "run",
          "--directory",
          "containers/engine",
          "python",
          "-c",
          `
      import datetime as dt
      import math
      import sys
      import polars as pl

      frame = pl.read_parquet(sys.argv[1])
      assert frame.height == 1
      row = frame.row(0, named=True)
      assert row["portfolio_id"] == sys.argv[2]
      assert row["as_of"] == dt.date.fromisoformat(sys.argv[3])
      assert row["observations"] == 3
      assert math.isclose(row["volatility"], 0.16655193949753938, abs_tol=1e-12)
      `,
          parquet,
          portfolio.id,
          processingDate,
        ],
        { timeout: "60 seconds" },
      );
      const completedPage = yield* page(`/workflow-runs/${runId}`);
      assert.match(completedPage, /annualised volatility from 3 returns/u);
      assert.match(completedPage, /portfolio_volatility/u);
      yield* evidence("completed", {
        run: finished,
        instance: completedInstance,
        platform: completedLog,
        publication,
      });

      const timeout = yield* api<{ id: string }>("POST", "/runs", {
        workflowId: portfolioWorkflow.id,
        subject,
        processingDate: "2024-01-06",
      });
      const timedOut = yield* runAt(timeout.id, "failed");
      assert.match(
        timedOut.error ?? "",
        /Timed out waiting for asset publications/u,
      );
      assert.ok(symbols.every((symbol) => timedOut.error?.includes(symbol)));
      const timeoutPage = yield* page(`/workflow-runs/${timeout.id}`);
      assert.match(timeoutPage, /Timed out waiting for asset publications/u);
      const timeoutLog = yield* platformLogs(timeout.id);
      assert.equal(
        step(timedOut, "dependencies").waiting?.deadline,
        platformStep(timeoutLog, "start wait dependencies").output,
      );
      assert.deepEqual(
        platformStep(timeoutLog, "check dependencies 2").attempts?.map(
          ({ success }) => success,
        ),
        [false],
      );
      yield* evidence("timed-out", { run: timedOut, platform: timeoutLog });

      const rerun = yield* api<{ id: string }>("POST", `/runs/${runId}/rerun`);
      assert.notEqual(rerun.id, runId);
      const rerunDetails = yield* runAt(rerun.id, "completed");
      assert.equal(rerunDetails.rerunOf, runId);
      assert.equal(rerunDetails.trigger, "manual");
      assert.equal(step(rerunDetails, "publish-updated").status, "completed");
      yield* evidence("rerun", rerunDetails);

      const terminal = yield* api<{ id: string }>("POST", "/runs", {
        workflowId: assetWorkflow.id,
        subject: assets[0],
        processingDate: "2023-12-31",
      });
      const invalid = yield* runAt(terminal.id, "failed");
      assert.match(invalid.error ?? "", /start date.*after the through date/u);
      assert.equal(step(invalid, "download").attempts, 1);
      const terminalLog = yield* platformLogs(terminal.id);
      assert.deepEqual(
        platformStep(terminalLog, "step download").attempts?.map(
          ({ success }) => success,
        ),
        [false],
      );
      yield* evidence("terminal", { run: invalid, platform: terminalLog });

      const unavailable = yield* newAsset(fixtureSymbol("RETRY"));
      yield* api("POST", `/workflows/${assetWorkflow.id}/assignments`, {
        subject: unavailable,
      });
      const transient = yield* api<{ id: string }>("POST", "/runs", {
        workflowId: assetWorkflow.id,
        subject: unavailable,
        processingDate,
      });
      const exhausted = yield* runAt(transient.id, "failed");
      assert.equal(step(exhausted, "download").attempts, 4);
      assert.match(exhausted.error ?? "", /EODHD request failed/u);
      const exhaustedLog = yield* platformLogs(transient.id);
      assert.deepEqual(
        platformStep(exhaustedLog, "step download").attempts?.map(
          ({ success }) => success,
        ),
        [false, false, false, false],
      );
      yield* evidence("exhausted", { run: exhausted, platform: exhaustedLog });
      yield* Console.log(`Evidence directory: ${evidenceDir}`);
    }),
).pipe(
  Command.withDescription(
    "Exercise the deployed smoke Worker's recovery paths and keep evidence",
  ),
);

runScript(command);
