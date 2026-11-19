import type {
  RunPlatform,
  WorkflowRunParams,
} from "$/workflows/runs/contracts";
import type { Steps } from "$/workflows/steps";

import { type LocalStepsOptions, localSteps } from "./steps";

/** Executes one run's Workflow body with the given steps adapter. */
export type ExecuteRun = (
  params: WorkflowRunParams,
  steps: Steps,
) => Promise<unknown>;

type LocalStatus = "queued" | "running" | "complete" | "errored";

/** One local Workflow instance and its checkpoints. */
export interface LocalInstance {
  readonly id: string;
  readonly params: WorkflowRunParams;
  readonly checkpoints: Map<string, string>;
  status: LocalStatus;
  /** How many times its body has started (above 1 after a replay). */
  executions: number;
  /** The error that ended it, when `errored`. */
  error?: unknown;
}

/** Options for the local Workflow binding. */
export interface LocalPlatformOptions {
  /** Start instances when created (default). False holds them `queued`. */
  readonly autoStart?: boolean;
  readonly steps?: Omit<LocalStepsOptions, "interruptBefore" | "onInterrupt">;
  /**
   * Simulate eviction: stop an execution before the named step (see
   * `LocalStepsOptions.interruptBefore`). `instance.executions` counts the
   * current execution from 1.
   */
  readonly interruptBefore?: (instance: LocalInstance, step: string) => boolean;
}

/** The local Workflow binding plus controls for tests and the fixture run. */
export interface LocalRunPlatform extends RunPlatform {
  readonly instances: ReadonlyMap<string, LocalInstance>;
  /** Start a held instance. */
  readonly start: (id: string) => void;
  /** Run an instance's body again over its checkpoints, as after eviction. */
  readonly replay: (id: string) => void;
  /** Settles once no execution is in progress. */
  readonly idle: () => Promise<void>;
}

/**
 * An in-process stand-in for the run Workflow binding. Instance IDs are
 * unique, as on the platform: creating an existing ID fails, and looking up
 * an unknown one fails. Each instance executes the same run body through the
 * local Steps adapter, keeping its checkpoints so it can be replayed.
 */
export const localRunPlatform = (
  execute: ExecuteRun,
  options: LocalPlatformOptions = {},
): LocalRunPlatform => {
  const instances = new Map<string, LocalInstance>();
  const pending = new Set<Promise<void>>();

  const handle = (instance: LocalInstance) =>
    ({
      id: instance.id,
      status: async () => ({
        status: instance.status,
        ...(instance.status === "errored"
          ? {
              error: {
                name: "Error",
                message:
                  instance.error instanceof Error
                    ? instance.error.message
                    : String(instance.error),
              },
            }
          : {}),
      }),
    }) as unknown as WorkflowInstance;

  const run = (instance: LocalInstance) => {
    instance.status = "running";
    instance.executions += 1;
    const settled = new Promise<void>((resolve) => {
      const steps = localSteps(instance.checkpoints, {
        ...options.steps,
        interruptBefore: (step) =>
          options.interruptBefore?.(instance, step) ?? false,
        // An evicted instance stays running until the platform replays it.
        onInterrupt: () => resolve(),
      });
      execute(instance.params, steps).then(
        () => {
          instance.status = "complete";
          resolve();
        },
        (error: unknown) => {
          instance.status = "errored";
          instance.error = error;
          resolve();
        },
      );
    });
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  };

  const find = (id: string) => {
    const instance = instances.get(id);
    if (instance === undefined) throw new Error("instance.not_found");
    return instance;
  };

  return {
    instances,
    create: async (create) => {
      const id = create?.id ?? crypto.randomUUID();
      if (instances.has(id)) throw new Error("instance.already_exists");
      const instance: LocalInstance = {
        id,
        params: create!.params!,
        checkpoints: new Map(),
        status: "queued",
        executions: 0,
      };
      instances.set(id, instance);
      if (options.autoStart ?? true) run(instance);
      return handle(instance);
    },
    get: async (id) => handle(find(id)),
    start: (id) => run(find(id)),
    replay: (id) => run(find(id)),
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
};
