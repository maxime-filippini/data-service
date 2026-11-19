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

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  type ExportedSchemas,
  GENERATED_PATH,
  generateOperationContracts,
  SCHEMAS_PATH,
} from "./operation-contracts";

const { values: options } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    "skip-python": { type: "boolean", default: false },
  },
});

const stale: string[] = [];

const update = (path: string, expected: string) => {
  const current = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  })();
  if (current === expected) return;
  if (options.check) stale.push(path);
  else {
    writeFileSync(path, expected);
    console.log(`Wrote ${path}`);
  }
};

if (!options["skip-python"])
  update(
    SCHEMAS_PATH,
    execFileSync(
      "uv",
      ["run", "--directory", "containers/engine", "engine", "export-schemas"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );

const exported = JSON.parse(
  readFileSync(SCHEMAS_PATH, "utf8"),
) as ExportedSchemas;
update(GENERATED_PATH, await generateOperationContracts(exported));

if (stale.length > 0) {
  console.error(
    `Stale operation contracts: ${stale.join(", ")}. Run \`pnpm operations:generate\`.`,
  );
  process.exitCode = 1;
}
