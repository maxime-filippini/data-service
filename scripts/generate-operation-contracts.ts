/**
 * Regenerate the operation contracts shared by Python and TypeScript:
 *
 *   pnpm operations:generate   export the Pydantic schemas, then generate TS
 *   pnpm operations:check      fail if either committed file is stale
 *
 * Step 1 runs `uv run engine export-schemas` in containers/engine and writes
 * src/operations/schemas.json. Step 2 generates
 * src/operations/contracts.generated.ts from it. `--skip-python` reuses the
 * committed schemas.json (for machines without uv).
 */

import { Console, Effect, FileSystem } from "effect";
import { Command, Flag } from "effect/cli";

import { runProcess, runScript, ScriptError } from "./cli";
import {
  type ExportedSchemas,
  GENERATED_PATH,
  generateOperationContracts,
  SCHEMAS_PATH,
} from "./operation-contracts";

const command = Command.make(
  "generate-operation-contracts",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fail if a committed file is stale; write nothing"),
    ),
    skipPython: Flag.Boolean("skip-python").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Reuse the committed schemas.json instead of uv"),
    ),
  },
  ({ check, skipPython }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stale: string[] = [];

      /** Write `expected` to `path`, or record it as stale under `--check`. */
      const update = (path: string, expected: string) =>
        Effect.gen(function* () {
          const current = yield* fs
            .readFileString(path)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (current === expected) return;
          if (check) stale.push(path);
          else {
            yield* fs.writeFileString(path, expected);
            yield* Console.log(`Wrote ${path}`);
          }
        });

      if (!skipPython)
        yield* update(
          SCHEMAS_PATH,
          yield* runProcess("uv", [
            "run",
            "--directory",
            "containers/engine",
            "engine",
            "export-schemas",
          ]),
        );

      const exported = JSON.parse(
        yield* fs.readFileString(SCHEMAS_PATH),
      ) as ExportedSchemas;
      yield* update(
        GENERATED_PATH,
        yield* Effect.promise(() => generateOperationContracts(exported)),
      );

      if (stale.length > 0)
        return yield* Effect.fail(
          new ScriptError(
            `Stale operation contracts: ${stale.join(", ")}. Run \`pnpm operations:generate\`.`,
          ),
        );
    }),
).pipe(
  Command.withDescription(
    "Export the Python operation schemas and generate the TypeScript contracts",
  ),
);

runScript(command);
