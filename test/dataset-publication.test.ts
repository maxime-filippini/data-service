/**
 * The asset workflow end to end across languages: the real executor and
 * step implementations, the fixture-backed EODHD adapter, and the real
 * Python service run with uv over HTTP, sharing a local artifact directory.
 * Requests go through the management API on real-migration SQLite.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Layer } from "effect";

import type { PublicationView } from "$/datasets/contracts";
import type { PublishedDatasets } from "$/datasets/store";
import { FileRunArtifactsLive } from "$/local/artifacts";
import { fixtureSourceFor, loadEodhdFixtures } from "$/local/eodhd-fixtures";
import {
  FilePublishedDatasetsLive,
  memoryPublishedDatasets,
} from "$/local/published";
import {
  type LocalPythonService,
  startPythonService,
  uvAvailable,
} from "$/local/python";
import { localWorkflowService } from "$/local/runs";
import { HttpPythonOperationsLive } from "$/operations/client";
import { pageData } from "$/pages";
import { createRoutes } from "$/routes";
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "$/workflows/runs/contracts";

import { makeTestDatabase } from "./support/d1";

const TOKEN = "management-token";
const ENGINE = fileURLToPath(
  new URL("../containers/engine/", import.meta.url).href,
);
const fixtures = loadEodhdFixtures(
  fileURLToPath(new URL("../fixtures/eodhd/", import.meta.url).href),
);
const PRICES_KEY = "dataset=prices_eod/symbol=AAPL.US/data.parquet";

const assetPrices = {
  name: "Daily asset prices",
  scope: "asset",
  enabled: true,
  schedule: { hourUtc: 2 },
  steps: [
    {
      id: "download",
      type: "download-prices",
      params: { startDate: "2024-01-01" },
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
};

/** A Parquet file's rows, read by Polars in the Python environment. */
const readParquet = async (path: string) => {
  const { stdout } = await promisify(execFile)("uv", [
    "run",
    "--directory",
    ENGINE,
    "python",
    "-c",
    "import sys, polars as pl; print(pl.read_parquet(sys.argv[1]).write_json())",
    path,
  ]);
  return JSON.parse(stdout) as Record<string, unknown>[];
};

const SKIP = uvAvailable()
  ? false
  : "uv is not installed, so the Python service cannot run; install uv to run these cross-language tests";

describe(
  "normalize and publish through the Python service",
  { skip: SKIP },
  () => {
    let root: string;
    let python: LocalPythonService;

    before(async () => {
      root = mkdtempSync(join(tmpdir(), "dataset-publication-"));
      python = await startPythonService({ artifactRoot: join(root, "raw") });
    });

    after(async () => {
      await python?.stop();
      rmSync(root, { recursive: true, force: true });
    });

    let counter = 0;

    const setup = (
      options: { readonly published?: Layer.Layer<PublishedDatasets> } = {},
    ) => {
      // Each test gets its own processed-bucket directory and database; run
      // artifacts share the Python service's directory (run IDs are unique).
      counter += 1;
      const processed = join(root, `processed-${counter}`);
      const { db } = makeTestDatabase();

      /** Faults injected at the D1 and HTTP boundaries. */
      const faults = { publicationWrites: 0, lostPythonResponses: 0 };
      const faultyDb = {
        ...db,
        prepare: (sql: string) => {
          const statement = db.prepare(sql);
          if (!/INSERT INTO dataset_publications/u.test(sql)) return statement;
          return {
            bind: (...values: unknown[]) => ({
              run: async () => {
                if (faults.publicationWrites > 0) {
                  faults.publicationWrites -= 1;
                  throw new Error("D1_ERROR: Network connection lost");
                }
                return statement.bind(...values).run();
              },
            }),
          };
        },
        batch: db.batch.bind(db),
      } as unknown as D1Database;

      const pythonRequests: { url: string; body: unknown }[] = [];
      const fetcher = {
        fetch: async (url: string, init: RequestInit) => {
          pythonRequests.push({ url, body: JSON.parse(String(init.body)) });
          const response = await fetch(url, init);
          if (faults.lostPythonResponses > 0) {
            // Python did the work, but the response never arrives.
            faults.lostPythonResponses -= 1;
            await response.arrayBuffer();
            throw new Error("Connection reset by peer");
          }
          return response;
        },
      };

      const provider: { respond: (url: URL) => Response | undefined } = {
        respond: () => undefined,
      };
      const service = localWorkflowService({
        db: faultyDb,
        artifacts: FileRunArtifactsLive(join(root, "raw")),
        sourceFor: fixtureSourceFor(fixtures, (url) => provider.respond(url)),
        python: HttpPythonOperationsLive(fetcher, python.url),
        published: options.published ?? FilePublishedDatasetsLive(processed),
        platform: { steps: { delayScale: 0 } },
      });
      const routes = createRoutes(service.dependencies, {
        fetch: () => new Response("app"),
      });
      const env = { MANAGEMENT_API_TOKEN: TOKEN } as CloudflareBindings;
      const api = (
        path: string,
        method = "GET",
        body?: unknown,
        headers: Record<string, string> = {},
      ) =>
        routes.request(
          `https://data-service.example.com/api${path}`,
          {
            method,
            headers: {
              ...headers,
              Authorization: `Bearer ${TOKEN}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          env,
        );
      const json = async <T = Record<string, unknown>>(
        response: Response | Promise<Response>,
        status = 200,
      ) => {
        const resolved = await response;
        const text = await resolved.text();
        assert.equal(resolved.status, status, text);
        return JSON.parse(text) as T;
      };

      const configure = async () => {
        await json(
          api("/assets", "POST", {
            symbol: "AAPL.US",
            provider: "eodhd",
            backfillStartDate: "2016-01-01",
          }),
          201,
        );
        const { id } = await json<{ id: string }>(
          api("/workflows", "POST", assetPrices),
          201,
        );
        await json(
          api(`/workflows/${id}/assignments`, "POST", {
            subject: { kind: "asset", symbol: "AAPL.US" },
          }),
          201,
        );
        return id;
      };

      /** Start a run for the date and wait for it to finish. */
      const runFor = async (workflowId: string, processingDate: string) => {
        const started = await json<WorkflowRunSummary>(
          api("/runs", "POST", {
            workflowId,
            subject: { kind: "asset", symbol: "AAPL.US" },
            processingDate,
          }),
          202,
        );
        await service.platform.idle();
        return json<WorkflowRunDetail>(api(`/runs/${started.id}`));
      };

      const publication = (status = 200) =>
        json<PublicationView>(
          api("/datasets/prices_eod/asset/AAPL.US"),
          status,
        );

      return {
        api,
        json,
        pages: pageData({} as CloudflareBindings, service.dependencies),
        configure,
        runFor,
        publication,
        faults,
        provider,
        pythonRequests,
        processed,
      };
    };

    test("an asset workflow downloads, normalizes in Python and publishes end-of-day prices", async () => {
      const { api, json, pages, configure, runFor, publication, processed } =
        setup();
      const workflowId = await configure();

      const run = await runFor(workflowId, "2024-01-05");
      assert.equal(run.status, "completed", run.error ?? "");
      assert.deepEqual(
        run.steps.map((step) => [step.id, step.status, step.attempts]),
        [
          ["download", "completed", 1],
          ["normalize", "completed", 1],
          ["publish", "completed", 1],
        ],
      );
      // Python returned a small reference to Parquet it wrote under the step.
      assert.deepEqual(run.steps[1]!.outputs, {
        prices: {
          id: `runs/${run.id}/normalize/prices.parquet`,
          format: "parquet",
          schema: "prices-eod/v1",
        },
      });
      assert.deepEqual(run.steps[2]!.outputs, {
        publication: {
          dataset: "prices_eod",
          subject: { kind: "asset", symbol: "AAPL.US" },
          processingDate: "2024-01-05",
        },
      });

      // The published data is at the location existing consumers read.
      const rows = await readParquet(join(processed, PRICES_KEY));
      assert.deepEqual(rows, [
        {
          date: "2024-01-02",
          open: 185.0,
          close: 186.11,
          high: 187.6,
          low: 183.52,
          adjusted_close: 186.11,
          volume: 52000000,
        },
        ...rows.slice(1),
      ]);
      assert.deepEqual(
        rows.map((row) => row["date"]),
        ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"],
      );

      const metadata = await publication();
      assert.deepEqual(
        {
          ...metadata,
          etag: undefined,
          size: undefined,
          publishedAt: undefined,
        },
        {
          dataset: "prices_eod",
          subject: { kind: "asset", symbol: "AAPL.US" },
          processingDate: "2024-01-05",
          producer: {
            workflowId,
            workflowName: "Daily asset prices",
            runId: run.id,
            stepId: "publish",
          },
          format: "parquet",
          schema: "prices-eod/v1",
          etag: undefined,
          size: undefined,
          publishedAt: undefined,
        },
      );
      const file = readFileSync(join(processed, PRICES_KEY));
      assert.equal(metadata.size, file.byteLength);

      const listed = await json<{ publications: PublicationView[] }>(
        api("/datasets?subjectKind=asset&subjectId=AAPL.US"),
      );
      assert.deepEqual(listed.publications, [metadata]);
      assert.deepEqual(
        (
          await json<{ publications: unknown[] }>(
            api("/datasets?subjectKind=asset&subjectId=MSFT.US"),
          )
        ).publications,
        [],
      );

      const data = await api("/datasets/prices_eod/asset/AAPL.US/data");
      assert.equal(data.status, 200);
      assert.equal(
        data.headers.get("Content-Type"),
        "application/vnd.apache.parquet",
      );
      assert.deepEqual(Buffer.from(await data.arrayBuffer()), file);
      const unchanged = await api(
        "/datasets/prices_eod/asset/AAPL.US/data",
        "GET",
        undefined,
        { "If-None-Match": data.headers.get("ETag")! },
      );
      assert.equal(unchanged.status, 304);

      await json(api("/datasets/prices_eod/asset/MSFT.US"), 404);

      // The app's asset page lists the publication the run's output names.
      assert.deepEqual((await pages.asset("AAPL.US")).publications, [metadata]);
    });

    test("published data outlives its temporary artifacts and the configuration that produced it", async () => {
      const { api, json, configure, runFor, publication } = setup();
      const workflowId = await configure();
      const run = await runFor(workflowId, "2024-01-05");
      assert.equal(run.status, "completed", run.error ?? "");
      const published = await (
        await api("/datasets/prices_eod/asset/AAPL.US/data")
      ).arrayBuffer();

      // The lifecycle rule expires the run's artifacts...
      rmSync(join(root, "raw", "runs", run.id), { recursive: true });
      assert.equal(
        (await api(`/runs/${run.id}/steps/normalize/artifacts/prices`)).status,
        404,
      );
      // ...and the asset and definition are deleted.
      assert.equal((await api("/assets/AAPL.US", "DELETE")).status, 204);
      assert.equal(
        (await api(`/workflows/${workflowId}`, "DELETE")).status,
        204,
      );

      const metadata = await publication();
      assert.equal(metadata.producer.runId, run.id);
      assert.equal(metadata.producer.workflowName, "Daily asset prices");
      const data = await api("/datasets/prices_eod/asset/AAPL.US/data");
      assert.equal(data.status, 200);
      assert.deepEqual(
        Buffer.from(await data.arrayBuffer()),
        Buffer.from(published),
      );
      assert.equal(
        (
          await json<{ publications: unknown[] }>(
            api("/datasets?subjectKind=asset"),
          )
        ).publications.length,
        1,
      );
    });

    test("a failed transformation leaves the previous publication intact", async () => {
      const { api, configure, runFor, publication, provider, processed } =
        setup();
      const workflowId = await configure();
      const first = await runFor(workflowId, "2024-01-05");
      assert.equal(first.status, "completed", first.error ?? "");
      const before = readFileSync(join(processed, PRICES_KEY));

      // The provider sends a row after the requested range: the download
      // keeps it, but Python's validation rejects it, terminally.
      provider.respond = () =>
        Response.json([
          ...(fixtures.get("AAPL.US") as unknown[]),
          {
            date: "2030-01-02",
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            adjusted_close: 1,
            volume: 1,
          },
        ]);
      const failed = await runFor(workflowId, "2024-01-10");
      assert.equal(failed.status, "failed");
      assert.deepEqual(
        failed.steps.map((step) => [step.id, step.status, step.attempts]),
        [
          ["download", "completed", 1],
          ["normalize", "failed", 1],
          ["publish", "skipped", 0],
        ],
      );
      assert.equal(
        failed.error,
        'Step "normalize" failed: A raw entry lies outside the requested range',
      );

      const metadata = await publication();
      assert.equal(metadata.processingDate, "2024-01-05");
      assert.equal(metadata.producer.runId, first.id);
      assert.deepEqual(readFileSync(join(processed, PRICES_KEY)), before);
      assert.equal(
        (await api("/datasets/prices_eod/asset/AAPL.US/data")).status,
        200,
      );
    });

    test("a call whose response was lost is repeated with the same identity and output location", async () => {
      const { configure, runFor, faults, pythonRequests } = setup();
      const workflowId = await configure();

      faults.lostPythonResponses = 1;
      const run = await runFor(workflowId, "2024-01-05");
      assert.equal(run.status, "completed", run.error ?? "");
      const normalize = run.steps.find((step) => step.id === "normalize")!;
      assert.equal(normalize.attempts, 2);
      assert.equal(normalize.error, null);

      assert.equal(pythonRequests.length, 2);
      assert.match(
        pythonRequests[0]!.url,
        /\/operations\/normalize-prices-eod$/u,
      );
      const expected = {
        execution: { runId: run.id, stepId: "normalize" },
        inputs: {
          raw: {
            id: `runs/${run.id}/download/raw.json`,
            format: "json",
            schema: "raw-prices-eod/v1",
          },
        },
        params: {},
      };
      assert.deepEqual(pythonRequests[0]!.body, expected);
      assert.deepEqual(pythonRequests[1]!.body, expected);
      // Both calls wrote the one object the run/step identity names.
      assert.deepEqual(
        readdirSync(join(root, "raw", "runs", run.id, "normalize")),
        ["prices.parquet"],
      );
    });

    test("a metadata write that fails after the object write is reconciled by the step's retry", async () => {
      const { configure, runFor, publication, faults, processed } = setup();
      const workflowId = await configure();

      faults.publicationWrites = 1;
      const run = await runFor(workflowId, "2024-01-05");
      assert.equal(run.status, "completed", run.error ?? "");
      const publish = run.steps.find((step) => step.id === "publish")!;
      assert.equal(publish.attempts, 2);
      assert.ok(existsSync(join(processed, PRICES_KEY)));
      const metadata = await publication();
      assert.equal(metadata.producer.runId, run.id);
      assert.equal(metadata.processingDate, "2024-01-05");
    });

    test("publication metadata is recorded only after the object write succeeds", async () => {
      const storage = memoryPublishedDatasets();
      const { configure, runFor, publication } = setup({
        published: storage.layer,
      });
      const workflowId = await configure();

      storage.faults.failPuts = 4;
      const run = await runFor(workflowId, "2024-01-05");
      assert.equal(run.status, "failed");
      assert.equal(
        run.error,
        'Step "publish" failed: Could not write the published dataset',
      );
      assert.equal(
        run.steps.find((step) => step.id === "publish")!.attempts,
        4,
      );
      assert.equal(storage.objects.size, 0);
      await publication(404);
    });
  },
);
