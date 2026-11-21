/**
 * Write the smoke Worker's Wrangler config into the private directory that
 * prepare.ts created, for the dedicated smoke D1 database:
 *
 *   node --import tsx scripts/cloudflare-smoke/configure.ts <dir> <database-id>
 *
 * It refuses names and database IDs that are not the smoke's own.
 */

import { Effect, FileSystem, Path } from "effect";
import { Argument, Command } from "effect/cli";

import { runScript, ScriptError } from "../cli";

const command = Command.make(
  "configure",
  {
    directory: Argument.String("private-directory").pipe(
      Argument.withDescription("The directory prepare.ts printed"),
    ),
    databaseId: Argument.String("smoke-database-id").pipe(
      Argument.withDescription("The smoke's dedicated D1 database ID"),
    ),
  },
  ({ directory, databaseId }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { resource, fixtureSymbolPrefix } = JSON.parse(
        yield* fs.readFileString(path.resolve(directory, "resources.json")),
      ) as { resource: string; fixtureSymbolPrefix: string };
      if (
        !/^data-service-workflow-smoke-[a-f0-9]{8}$/u.test(resource) ||
        fixtureSymbolPrefix !== `SMOKE-${resource.slice(-8).toUpperCase()}` ||
        !/^[a-f0-9-]{36}$/u.test(databaseId) ||
        [
          "02d3dda4-f7b7-4bd1-a1db-e6e9a738b297",
          "7b4372d2-9175-408b-b2d2-3dea4de80359",
        ].includes(databaseId)
      )
        return yield* Effect.fail(
          new ScriptError("Expected a dedicated smoke Worker and D1 database"),
        );

      const config = {
        name: resource,
        main: path.resolve("scripts/cloudflare-smoke/worker.ts"),
        compatibility_date: "2026-10-02",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        preview_urls: false,
        observability: { enabled: true, traces: { enabled: true } },
        assets: {
          directory: path.resolve("dist"),
          binding: "ASSETS",
          run_worker_first: true,
        },
        vars: {
          RAW_BUCKET_NAME: "raw-market-data-dev",
          PROCESSED_BUCKET_NAME: "processed-market-data-dev",
          WORKFLOW_DISPATCH: "on",
          SMOKE_SYMBOL_PREFIX: fixtureSymbolPrefix,
        },
        workflows: [
          {
            name: resource,
            binding: "WORKFLOW_RUNS",
            class_name: "SmokeDefinitionRun",
          },
        ],
        containers: [
          {
            class_name: "CalculationEngine",
            image: path.resolve("containers/engine/Dockerfile"),
            image_build_context: path.resolve("containers/engine"),
            max_instances: 1,
            instance_type: "basic",
          },
        ],
        durable_objects: {
          bindings: [
            { name: "CALCULATION_ENGINE", class_name: "CalculationEngine" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["CalculationEngine"] }],
        r2_buckets: [
          { bucket_name: "raw-market-data-dev", binding: "MARKET_DATA_BUCKET" },
          {
            bucket_name: "processed-market-data-dev",
            binding: "PROCESSED_MARKET_DATA_BUCKET",
          },
        ],
        d1_databases: [
          {
            binding: "MARKET_DATA_DB",
            database_name: resource,
            database_id: databaseId,
            migrations_dir: path.resolve("migrations"),
          },
        ],
      };

      yield* fs.writeFileString(
        path.resolve(directory, "wrangler.smoke.json"),
        JSON.stringify(config, null, 2),
        { mode: 0o600 },
      );
    }),
).pipe(Command.withDescription("Write the smoke Worker's Wrangler config"));

runScript(command);
