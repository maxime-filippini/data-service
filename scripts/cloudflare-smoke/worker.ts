import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect, Layer } from "effect";
import { Hono } from "hono";
import { createLocalJWKSet, type JWK } from "jose";

import { D1AssetStoreLive } from "$/assets/d1";
import { requireManagementToken } from "$/auth";
import { DatasetError } from "$/datasets/contracts";
import { D1PublicationStoreLive } from "$/datasets/d1";
import { R2PublishedFileStoreLive } from "$/datasets/r2";
import { PublicationStore } from "$/datasets/store";
import { cloudflareServices } from "$/dependencies";
import { fixtureSourceFor } from "$/local/eodhd-fixtures";
import { PriceProvidersLayer } from "$/market-data/sources";
import { HttpPythonOperationsLive } from "$/operations/client";
import { D1PortfoliosLive } from "$/portfolios/d1";
import { createRoutes } from "$/routes";
import { R2RunArtifactStoreLive } from "$/workflows/artifacts";
import type { Checkpointer } from "$/workflows/checkpointer";
import {
  CloudflareCheckpointerLive,
  runInstanceBody,
} from "$/workflows/cloudflare";
import { executeWorkflowRun } from "$/workflows/executor";
import { StepRegistryLive } from "$/workflows/registry";
import type {
  RunWorkflowBinding,
  WorkflowRunParams,
} from "$/workflows/runs/contracts";
import { D1WorkflowRunStoreLive } from "$/workflows/runs/d1";
import {
  RunCoordinatorLive,
  scheduledWorkflowTick,
} from "$/workflows/runs/coordinator";
import { BindingRunLauncherLive } from "$/workflows/runs/launcher";

// @ts-expect-error -- built SvelteKit adapter, as in the main Worker.
import sveltekit from "../../app/.svelte-kit/cloudflare/_worker.js";
import aapl from "../../fixtures/eodhd/AAPL.US.json";
import msft from "../../fixtures/eodhd/MSFT.US.json";

export { CalculationEngine } from "$/engine-container";

const control = new Hono<{ Bindings: SmokeBindings }>();

type SmokeBindings = CloudflareBindings & {
  SMOKE_SYMBOL_PREFIX: string;
  SMOKE_ACCESS_JWK: string;
};

type LaunchFault = "lose-create-and-lookup" | "lose-lookup";

/** Durable fault markers also preserve the result observed before it was lost. */
async function recordFault(
  db: D1Database,
  runId: string,
  point: string,
  detail: unknown,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO smoke_faults (run_id, point, detail) VALUES (?, ?, ?)
       ON CONFLICT (run_id, point) DO NOTHING RETURNING point`,
    )
    .bind(runId, point, JSON.stringify(detail))
    .first();
  return inserted !== null;
}

function fixtureSources(prefix: string) {
  return fixtureSourceFor(new Map(), (url) => {
    const symbol = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (!symbol.startsWith(`${prefix}-`)) return undefined;
    if (symbol.endsWith("-RETRY.US"))
      return new Response("Smoke provider unavailable", { status: 503 });
    const rows = symbol.endsWith("-B.US") ? msft : aapl;
    const start = url.searchParams.get("from") ?? "0000-00-00";
    const end = url.searchParams.get("to") ?? "9999-12-31";
    return Response.json(
      rows.filter(({ date }) => date >= start && date <= end),
    );
  });
}

function platform(env: SmokeBindings, fault: LaunchFault): RunWorkflowBinding {
  return {
    create: async (options) => {
      const instance = await env.WORKFLOW_RUNS.create(options);
      if (fault === "lose-create-and-lookup") {
        await recordFault(env.MARKET_DATA_DB, instance.id, "create", {
          instanceId: instance.id,
        });
        throw new Error("Smoke lost Workflow creation acknowledgement");
      }
      return instance;
    },
    get: async (id) => {
      await recordFault(env.MARKET_DATA_DB, id, "lookup", { fault });
      throw new Error("Smoke unavailable Workflow status");
    },
  };
}

function publicationsWithFault(db: D1Database) {
  return Layer.effect(
    PublicationStore,
    Effect.gen(function* () {
      const store = yield* PublicationStore;
      return PublicationStore.of({
        ...store,
        record: (publication) =>
          Effect.gen(function* () {
            if (publication.dataset === "portfolio_volatility") {
              const first = yield* Effect.promise(() =>
                recordFault(db, publication.runId, "publication-metadata", {
                  etag: publication.etag,
                  size: publication.size,
                }),
              );
              if (first)
                return yield* new DatasetError({
                  kind: "database",
                  message:
                    "Smoke interrupted publication before metadata write",
                });
            }
            return yield* store.record(publication);
          }),
      });
    }),
  ).pipe(Layer.provide(D1PublicationStoreLive(db)));
}

/** Only this Worker wraps the production adapters with injected faults. */
export class SmokeDefinitionRun extends WorkflowEntrypoint<
  SmokeBindings,
  WorkflowRunParams
> {
  override async run(
    event: WorkflowEvent<WorkflowRunParams>,
    step: WorkflowStep,
  ) {
    const env = this.env;
    const db = env.MARKET_DATA_DB;
    const engine = env.CALCULATION_ENGINE.getByName("engine");
    const fetcher = {
      async fetch(url: string, init: RequestInit) {
        const response = await engine.fetch(url, init);
        if (response.ok && url.endsWith("/calculate-portfolio-volatility")) {
          const outputs = await response.clone().json();
          if (
            await recordFault(db, event.instanceId, "python-response", outputs)
          )
            throw new Error("Smoke lost a successful Python response");
        }
        return response;
      },
    };
    const layer = Layer.mergeAll(
      CloudflareCheckpointerLive(
        step,
        (message) => new NonRetryableError(message),
      ),
      D1WorkflowRunStoreLive(db),
      StepRegistryLive,
      D1AssetStoreLive(db),
      D1PortfoliosLive(db),
      PriceProvidersLayer(fixtureSources(env.SMOKE_SYMBOL_PREFIX)),
      R2RunArtifactStoreLive(env.MARKET_DATA_BUCKET),
      HttpPythonOperationsLive(fetcher, "http://engine"),
      publicationsWithFault(db),
      R2PublishedFileStoreLive(env.PROCESSED_MARKET_DATA_BUCKET),
    );
    return runInstanceBody(
      executeWorkflowRun(event.payload).pipe(Effect.provide(layer)),
    );
  }
}

/**
 * Runs the dispatch body inside the request or cron invocation: the smoke
 * exercises recovery of the runs it launches, not of the dispatcher itself.
 */
const inlineCheckpointer: typeof Checkpointer.Service = {
  checkpoint: (_name, body) => body,
  sleepUntil: () => Effect.void,
};

control.use("/__smoke/*", requireManagementToken);
control.post("/__smoke/tick", async (c) => {
  const tick = await c.req.json<{ at: string; fault?: LaunchFault }>();
  const at = new Date(tick.at);
  if (!Number.isFinite(at.valueOf()))
    return c.json({ error: "Invalid tick" }, 400);
  const { env } = c;
  const { fault } = tick;
  // A fault replaces the launcher the coordinator launches runs with.
  const services =
    fault === undefined
      ? cloudflareServices(env)
      : Layer.provideMerge(
          RunCoordinatorLive,
          Layer.merge(
            cloudflareServices(env),
            BindingRunLauncherLive(platform(env, fault)),
          ),
        );
  return c.json(
    await scheduledWorkflowTick(services, env, at, inlineCheckpointer),
  );
});
control.get("/__smoke/instances/:id", async (c) => {
  const id = c.req.param("id");
  const instance = await c.env.WORKFLOW_RUNS.get(id);
  const rows = await c.env.MARKET_DATA_DB.prepare(
    "SELECT point, detail FROM smoke_faults WHERE run_id = ? ORDER BY point",
  )
    .bind(id)
    .all<{ point: string; detail: string }>();
  return c.json({
    status: await instance.status(),
    faults: rows.results.map(({ point, detail }) => ({
      point,
      detail: JSON.parse(detail) as unknown,
    })),
  });
});

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/__smoke/"))
      return control.fetch(request, env, ctx);
    const keys = createLocalJWKSet({
      keys: [JSON.parse(env.SMOKE_ACCESS_JWK) as JWK],
    });
    return createRoutes(cloudflareServices, sveltekit, () => keys).fetch(
      request,
      env,
      ctx,
    );
  },
  async scheduled(controller, env) {
    await scheduledWorkflowTick(
      cloudflareServices(env),
      env,
      new Date(controller.scheduledTime),
      inlineCheckpointer,
    );
  },
} satisfies ExportedHandler<SmokeBindings>;
