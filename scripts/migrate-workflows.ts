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

import { Console, Effect, FileSystem, Option, Path } from "effect";
import { Command, Flag } from "effect/cli";

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

import { runScript, ScriptError } from "./cli";

const mode = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withDefault(false),
    Flag.withDescription(description),
  );

const renderSql = {
  apply: renderApplyMigrationSql,
  cutover: renderCutoverSql,
  rollback: renderRollbackSql,
} as const;

/** Write text to stdout as is (the SQL already ends with a newline). */
const print = (text: string) =>
  Console.log(text.endsWith("\n") ? text.slice(0, -1) : text);

const command = Command.make(
  "migrate-workflows",
  {
    db: Flag.String("db").pipe(
      Flag.optional,
      Flag.withDescription("The SQLite database to rehearse against"),
    ),
    dryRun: mode("dry-run", "Report the inventory without writing (default)"),
    apply: mode("apply", "Create the assets, workflows and assignments"),
    cutover: mode("cutover", "Pause legacy downloads for workflow dispatch"),
    rollback: mode("rollback", "Resume legacy downloads"),
    emitSql: Flag.Literals("emit-sql", ["apply", "cutover", "rollback"]).pipe(
      Flag.optional,
      Flag.withDescription("Print the SQL for remote D1 instead of running it"),
    ),
    now: Flag.String("now").pipe(
      Flag.optional,
      Flag.withDescription("The migration time, as an ISO timestamp"),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const now = Option.getOrElse(options.now, () => new Date().toISOString());
      const selectedModes = [
        options.dryRun ? "dry-run" : null,
        options.apply ? "apply" : null,
        options.cutover ? "cutover" : null,
        options.rollback ? "rollback" : null,
        Option.isSome(options.emitSql) ? "emit-sql" : null,
      ].filter((selected) => selected !== null);
      if (selectedModes.length > 1)
        return yield* Effect.fail(
          new ScriptError(
            `Choose only one mode flag (got: ${selectedModes.join(", ")}). See --help.`,
          ),
        );

      if (Option.isSome(options.emitSql))
        return yield* print(renderSql[options.emitSql.value](now));

      if (Option.isNone(options.db))
        return yield* Effect.fail(
          new ScriptError(
            "Missing required --db <sqlite-path> argument. See --help.",
          ),
        );
      const fs = yield* FileSystem.FileSystem;
      const dbPath = (yield* Path.Path).resolve(options.db.value);
      if (!(yield* fs.exists(dbPath)))
        return yield* Effect.fail(
          new ScriptError(`SQLite database file not found: ${dbPath}`),
        );

      const { db } = yield* Effect.acquireRelease(
        Effect.sync(() => openSqliteD1(dbPath)),
        ({ sqlite }) => Effect.sync(() => sqlite.close()),
      );
      const program: Effect.Effect<unknown, MigrationError> = options.apply
        ? applyMigration(db, { now })
        : options.cutover
          ? cutoverDownloads(db, { now })
          : options.rollback
            ? rollbackDownloads(db, { now })
            : inventoryMigration(db, { now });
      const outcome = yield* program.pipe(
        Effect.mapError(
          (failure) =>
            new ScriptError(
              JSON.stringify(
                {
                  error: failure._tag,
                  kind: failure.kind,
                  message: failure.message,
                },
                null,
                2,
              ),
            ),
        ),
      );
      yield* print(`${JSON.stringify(outcome, null, 2)}\n`);
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Migrate legacy download registrations to workflows, cut over or roll back",
  ),
);

runScript(command);
