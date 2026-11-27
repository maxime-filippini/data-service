import { Context, Effect, Layer } from "effect";

import type { RunWorkflowBinding } from "./contracts";

/** What a launch attempt established. */
export type LaunchOutcome = "launched" | "uncertain";

/**
 * Starts and looks up the durable instance that executes a run. The
 * instance's ID is the run's ID, so launching the same run again can never
 * start a second instance.
 */
export class RunLauncher extends Context.Service<
  RunLauncher,
  {
    /**
     * Create the run's instance. `launched` when it exists afterwards (this
     * or an earlier attempt created it); `uncertain` when that can't be
     * told, so the run stays queued for reconciliation.
     */
    readonly launch: (runId: string) => Effect.Effect<LaunchOutcome>;
    /**
     * The instance's platform status (such as `running` or `complete`), or
     * undefined when it can't be determined: the instance is absent or the
     * platform unreachable.
     */
    readonly status: (runId: string) => Effect.Effect<string | undefined>;
  }
>()("data-service/RunLauncher") {}

/**
 * The RunLauncher over a Workflow binding: Cloudflare's `WORKFLOW_RUNS`, or
 * the local in-process stand-in with the same create and get semantics.
 */
export const bindingRunLauncher = (
  binding: RunWorkflowBinding,
): typeof RunLauncher.Service =>
  RunLauncher.of({
    launch: (runId) =>
      Effect.promise(async (): Promise<LaunchOutcome> => {
        try {
          await binding.create({ id: runId, params: { runId } });
          return "launched";
        } catch {
          // The create may have gone through with its response lost.
          return binding.get(runId).then(
            () => "launched" as const,
            () => "uncertain" as const,
          );
        }
      }),
    status: (runId) =>
      Effect.promise(() =>
        binding
          .get(runId)
          .then((instance) => instance.status())
          .then(
            (status): string | undefined => status.status,
            () => undefined,
          ),
      ),
  });

/** `bindingRunLauncher` as a Layer. */
export const BindingRunLauncherLive = (
  binding: RunWorkflowBinding,
): Layer.Layer<RunLauncher> =>
  Layer.succeed(RunLauncher, bindingRunLauncher(binding));
