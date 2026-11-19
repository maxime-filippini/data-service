/**
 * Rehearsal and operator CLI for migrating legacy download registrations to
 * workflows, cutting automatic downloads over, and rolling back:
 *
 *   pnpm workflow:migrate --db <sqlite-path> [--dry-run | --apply | --cutover | --rollback] [--now <iso>]
 *   pnpm workflow:migrate --emit-sql <apply | cutover | rollback> [--now <iso>]
 *
 * Against a local SQLite database (`--db`), defaults to `--dry-run` (read-only
 * inventory report, zero writes). Against remote Cloudflare D1, first export a
 * backup and rehearse locally, then emit and review SQL with `--emit-sql` and
 * apply it with `wrangler d1 execute <db> --remote --file <sql-file>`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Effect, Result } from "effect";

import { openSqliteD1 } from "$/local/sqlite-d1";
import {
  applyMigration,
  cutoverDownloads,
  inventoryMigration,
  type MigrationError,
  renderApplyMigrationSql,
  renderCutoverSql,
  renderRollbackSql,
  rollbackDownloads,
} from "$/workflows/migration";

const USAGE = `Usage:
  node --import tsx scripts/migrate-workflows.ts --db <sqlite-path> [--dry-run | --apply | --cutover | --rollback] [--now <iso>]
  node --import tsx scripts/migrate-workflows.ts --emit-sql <apply | cutover | rollback> [--now <iso>]
`;

const { values: options } = parseArgs({
  options: {
    db: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    cutover: { type: "boolean", default: false },
    rollback: { type: "boolean", default: false },
    "emit-sql": { type: "string" },
    now: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (options.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const now = options.now ?? new Date().toISOString();

const selectedModes = [
  options["dry-run"] ? "dry-run" : null,
  options.apply ? "apply" : null,
  options.cutover ? "cutover" : null,
  options.rollback ? "rollback" : null,
  options["emit-sql"] !== undefined ? "emit-sql" : null,
].filter((mode): mode is string => mode !== null);

if (selectedModes.length > 1) {
  console.error(
    `Choose only one mode flag (got: ${selectedModes.join(", ")}).\n${USAGE}`,
  );
  process.exit(1);
}

if (options["emit-sql"] !== undefined) {
  const kind = options["emit-sql"];
  if (kind === "apply") {
    process.stdout.write(renderApplyMigrationSql(now));
  } else if (kind === "cutover") {
    process.stdout.write(renderCutoverSql(now));
  } else if (kind === "rollback") {
    process.stdout.write(renderRollbackSql(now));
  } else {
    console.error(
      `Unknown --emit-sql target "${kind}"; expected apply, cutover, or rollback.\n${USAGE}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (options.db === undefined) {
  console.error(`Missing required --db <sqlite-path> argument.\n${USAGE}`);
  process.exit(1);
}

const dbPath = resolve(options.db);
if (!existsSync(dbPath)) {
  console.error(`SQLite database file not found: ${dbPath}`);
  process.exit(1);
}

const { sqlite, db } = openSqliteD1(dbPath);
try {
  const program: Effect.Effect<unknown, MigrationError> = options.apply
    ? applyMigration(db, { now })
    : options.cutover
      ? cutoverDownloads(db, { now })
      : options.rollback
        ? rollbackDownloads(db, { now })
        : inventoryMigration(db, { now });

  const outcome = await program.pipe(Effect.result, Effect.runPromise);
  if (Result.isFailure(outcome)) {
    console.error(
      JSON.stringify(
        {
          error: outcome.failure._tag,
          kind: outcome.failure.kind,
          message: outcome.failure.message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(outcome.success, null, 2)}\n`);
  }
} finally {
  sqlite.close();
}
