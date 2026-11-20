/**
 * Create the smoke's private directory: random resource names, generated
 * secrets and an Access key pair, with the dev R2 credentials from an env
 * file. Prints the directory and names as JSON:
 *
 *   node --import tsx scripts/cloudflare-smoke/prepare.ts [.dev.vars]
 */

import { parseEnv } from "node:util";

import { exportJWK, generateKeyPair } from "jose";
import { Console, Crypto, Effect, FileSystem, Path } from "effect";
import { Argument, Command } from "effect/cli";

import { runScript, ScriptError } from "../cli";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const command = Command.make(
  "prepare",
  {
    envFile: Argument.String("env-file").pipe(
      Argument.withDefault(".dev.vars"),
      Argument.withDescription("Env file with the dev R2 S3 credentials"),
    ),
  },
  ({ envFile }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;

      const env = parseEnv(yield* fs.readFileString(envFile));
      const r2 = {
        R2_ENDPOINT_URL: env.R2_ENDPOINT_URL,
        R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      };
      const endpoint = URL.parse(r2.R2_ENDPOINT_URL ?? "");
      if (
        endpoint?.protocol !== "https:" ||
        !endpoint.hostname.endsWith(".r2.cloudflarestorage.com") ||
        !r2.R2_ACCESS_KEY_ID ||
        !r2.R2_SECRET_ACCESS_KEY
      )
        return yield* Effect.fail(
          new ScriptError(
            "Provide S3 credentials scoped to the two dev R2 buckets",
          ),
        );

      const directory = yield* fs.makeTempDirectory({
        prefix: "data-service-workflow-smoke.",
      });
      const suffix = hex(yield* crypto.randomBytes(4));
      const resource = `data-service-workflow-smoke-${suffix}`;
      const fixtureSymbolPrefix = `SMOKE-${suffix.toUpperCase()}`;
      const { publicKey, privateKey } = yield* Effect.promise(() =>
        generateKeyPair("RS256", { extractable: true }),
      );
      const secrets = {
        ...r2,
        MANAGEMENT_API_TOKEN: hex(yield* crypto.randomBytes(32)),
        SMOKE_ACCESS_JWK: JSON.stringify(
          yield* Effect.promise(() => exportJWK(publicKey)),
        ),
        ACCESS_TEAM_DOMAIN: "smoke.invalid",
        ACCESS_AUD: `${resource}-app`,
        DASHBOARD_ALLOWED_EMAILS: "workflow-smoke@smoke.invalid",
      };
      const writePrivate = (file: string, value: unknown) =>
        fs.writeFileString(path.join(directory, file), JSON.stringify(value), {
          mode: 0o600,
        });
      yield* writePrivate("secrets.json", secrets);
      yield* writePrivate(
        "access-private.jwk.json",
        yield* Effect.promise(() => exportJWK(privateKey)),
      );
      yield* writePrivate("resources.json", { resource, fixtureSymbolPrefix });
      yield* Console.log(
        JSON.stringify({ directory, resource, fixtureSymbolPrefix }),
      );
    }),
).pipe(
  Command.withDescription(
    "Create the smoke's private directory, names and secrets",
  ),
);

runScript(command);
