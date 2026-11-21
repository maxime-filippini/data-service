/**
 * Shared plumbing for the repo's scripts: each one is an Effect CLI
 * `Command`, run on Node's platform services (file system, path, child
 * processes, stdio), so handlers stay effects instead of calling Node directly.
 */

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, Option, Stream } from "effect";
import { CliError, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ManagementApiError } from "$/management-api/client";

/** An expected script failure: only its message is printed. */
export class ScriptError extends Error {
  override readonly name = "ScriptError";
}

/** Say why a script failed. The CLI already printed usage errors with help. */
const report = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && CliError.isCliError(error.value))
    return Effect.void;
  if (
    Option.isSome(error) &&
    (error.value instanceof ScriptError ||
      error.value instanceof ManagementApiError)
  )
    return Console.error(error.value.message);
  return Console.error(Cause.pretty(cause));
};

/**
 * Parse the process arguments and run the command on Node's services. A
 * failure exits with code 1.
 */
export const runScript = <Name extends string, Input, E>(
  command: Command.Command<Name, Input, {}, E, NodeServices.NodeServices>,
): void =>
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.tapCause(report),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );

/**
 * Run a command to completion and return its standard output. Standard error
 * goes to the terminal; a non-zero exit fails with a `ScriptError`.
 */
export const runProcess = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          ...options,
          stdin: "ignore",
          stderr: "inherit",
        }),
      );
      const [output, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* Effect.fail(
          new ScriptError(
            `${command} ${args.join(" ")} exited with code ${code}`,
          ),
        );
      return output;
    }),
  );
