/**
 * Run the Cloudflare recovery smoke locally in one command:
 *
 *   pnpm smoke:local [--env-file .dev.vars] [--container] [--port 8787]
 *                    [--engine-port 8790]
 *
 * It prepares a fresh private directory, writes the local config, applies
 * the migrations to local D1, builds the app, then starts the Python engine
 * (a local uv process, or the container with --container) and a
 * `wrangler dev` session, runs run.ts against it and stops everything.
 * Workflows, D1 and Durable Objects are local; the two dev R2 buckets are
 * remote bindings, as in the deployed smoke. The env file needs the dev R2
 * S3 credentials, and Wrangler must be logged in for the remote buckets.
 * Logs and evidence stay in the printed directory.
 */

import { parseEnv } from "node:util";

import { Console, Effect, FileSystem, Path, Schedule, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { runProcess, runScript, ScriptError } from "../cli";

const RAW_BUCKET = "raw-market-data-dev";
const PROCESSED_BUCKET = "processed-market-data-dev";

const command = Command.make(
  "smoke-local",
  {
    envFile: Flag.String("env-file").pipe(
      Flag.withDefault(".dev.vars"),
      Flag.withDescription("Env file with the dev R2 S3 credentials"),
    ),
    container: Flag.Boolean("container").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Start the engine container through Docker instead of a local uv process",
      ),
    ),
    port: Flag.Int("port").pipe(
      Flag.withDefault(8787),
      Flag.withDescription("Port for wrangler dev"),
    ),
    enginePort: Flag.Int("engine-port").pipe(
      Flag.withDefault(8790),
      Flag.withDescription("Port for the local engine process"),
    ),
  },
  (options) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const tsx = ["--import", "tsx"];

        // 1. A fresh private directory and the local config.
        const { directory, resource } = JSON.parse(
          yield* runProcess("node", [
            ...tsx,
            "scripts/cloudflare-smoke/prepare.ts",
            options.envFile,
          ]),
        ) as { directory: string; resource: string };
        yield* Console.log(`Smoke directory: ${directory}`);
        const engineUrl = `http://localhost:${options.enginePort}`;
        yield* runProcess("node", [
          ...tsx,
          "scripts/cloudflare-smoke/configure.ts",
          directory,
          "--local",
          ...(options.container ? [] : ["--engine-url", engineUrl]),
        ]);
        const config = path.join(directory, "wrangler.smoke.json");
        const state = path.join(directory, "state");
        const local = ["--local", "--config", config, "--persist-to", state];

        // 2. Local D1 with the repository migrations and the fault table.
        yield* Console.log("Applying migrations to local D1…");
        yield* runProcess("pnpm", [
          "exec",
          "wrangler",
          "d1",
          "migrations",
          "apply",
          resource,
          ...local,
        ]);
        yield* runProcess("pnpm", [
          "exec",
          "wrangler",
          "d1",
          "execute",
          resource,
          ...local,
          "--file",
          "scripts/cloudflare-smoke/setup.sql",
        ]);
        yield* Console.log("Building the app…");
        yield* runProcess("pnpm", ["--filter", "app", "build"]);

        /** Start a process for the rest of the run, logging to a file. */
        const background = (
          name: string,
          cmd: string,
          args: readonly string[],
          env: Record<string, string | undefined> = {},
        ) =>
          Effect.gen(function* () {
            const log = path.join(directory, `${name}.log`);
            const handle = yield* spawner.spawn(
              ChildProcess.make(cmd, args, {
                env,
                extendEnv: true,
                stdin: "ignore",
              }),
            );
            const output = Stream.merge(handle.stdout, handle.stderr);
            yield* Effect.forkScoped(Stream.run(output, fs.sink(log)));
            return { handle, log };
          });

        /** Poll a URL until it answers, or fail with the log's location. */
        const ready = (name: string, url: string, log: string) =>
          Effect.tryPromise(() => fetch(url, { redirect: "manual" })).pipe(
            Effect.retry(
              Schedule.spaced("1 second").pipe(
                Schedule.upTo({ duration: "4 minutes" }),
              ),
            ),
            Effect.mapError(
              () => new ScriptError(`${name} did not start; see ${log}`),
            ),
            Effect.asVoid,
          );

        // 3. The engine, unless the container stands in for it.
        if (!options.container) {
          const secrets = parseEnv(
            yield* fs.readFileString(path.join(directory, ".dev.vars")),
          );
          const engine = yield* background(
            "engine",
            "uv",
            [
              "run",
              "--directory",
              "containers/engine",
              "uvicorn",
              "data_service_engine.app:app",
              "--host",
              "127.0.0.1",
              "--port",
              String(options.enginePort),
            ],
            {
              R2_ENDPOINT_URL: secrets.R2_ENDPOINT_URL,
              R2_ACCESS_KEY_ID: secrets.R2_ACCESS_KEY_ID,
              R2_SECRET_ACCESS_KEY: secrets.R2_SECRET_ACCESS_KEY,
              ARTIFACT_BUCKET: RAW_BUCKET,
              PROCESSED_BUCKET,
              // A local .env must not turn file storage back on.
              ARTIFACT_ROOT: undefined,
              PROCESSED_ROOT: undefined,
            },
          );
          yield* ready("The engine", `${engineUrl}/health`, engine.log);
        } else {
          // workerd starts containers under names derived from the Worker.
          yield* Effect.addFinalizer(() =>
            runProcess("sh", [
              "-c",
              `docker ps -aq --filter name=workerd-${resource} | xargs -r docker rm -f`,
            ]).pipe(Effect.ignore),
          );
        }

        // 4. The smoke Worker under wrangler dev.
        yield* Console.log("Starting wrangler dev…");
        const worker = yield* background("wrangler", "pnpm", [
          "exec",
          "wrangler",
          "dev",
          "--config",
          config,
          "--env-file",
          path.join(directory, ".dev.vars"),
          "--persist-to",
          state,
          "--port",
          String(options.port),
          "--tsconfig",
          path.resolve("tsconfig.json"),
          "--show-interactive-dev-session=false",
          `--enable-containers=${options.container}`,
        ]);
        yield* ready(
          "wrangler dev",
          `http://localhost:${options.port}/`,
          worker.log,
        );

        // 5. The assertions, with their progress on this terminal.
        const run = yield* spawner.spawn(
          ChildProcess.make(
            "node",
            [
              ...tsx,
              "scripts/cloudflare-smoke/run.ts",
              directory,
              `http://localhost:${options.port}`,
            ],
            { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
          ),
        );
        const code = yield* run.exitCode;
        if (code !== 0)
          return yield* Effect.fail(
            new ScriptError(
              `The smoke failed; logs are in ${directory} (wrangler.log${options.container ? "" : ", engine.log"})`,
            ),
          );
        yield* Console.log(`Smoke passed. Evidence and logs: ${directory}`);
      }),
    ),
).pipe(
  Command.withDescription(
    "Run the Cloudflare recovery smoke against a local wrangler dev session",
  ),
);

runScript(command);
