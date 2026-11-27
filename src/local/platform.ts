import { Cause, Effect, Exit } from "effect";

import type { Checkpointer } from "$/workflows/checkpointer";
import type {
  RunWorkflowBinding,
  WorkflowRunParams,
} from "$/workflows/runs/contracts";

import {
  type LocalCheckpointEvent,
  type LocalCheckpointerOptions,
  localCheckpointer,
} from "./checkpointer";

/** One run's Workflow body, given the instance's Checkpointer. */
export type ExecuteRun = (
  params: WorkflowRunParams,
  checkpointer: typeof Checkpointer.Service,
) => Effect.Effect<unknown, unknown>;

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
  readonly checkpointer?: Omit<
    LocalCheckpointerOptions,
    "interruptBefore" | "onEvent"
  >;
  /**
   * Simulate eviction: interrupt an execution before the named checkpoint
   * (see `LocalCheckpointerOptions.interruptBefore`). `instance.executions`
   * counts the current execution from 1.
   */
  readonly interruptBefore?: (
    instance: LocalInstance,
    checkpoint: string,
  ) => boolean;
  /**
   * Notified when an execution of an instance's body begins and of every
   * checkpoint event in it, for tracing.
   */
  readonly onEvent?: (
    instance: LocalInstance,
    event: LocalCheckpointEvent | { readonly type: "execution" },
  ) => void;
}

/** The local Workflow binding plus controls for tests and the fixture run. */
export interface LocalRunPlatform extends RunWorkflowBinding {
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
 * an unknown one fails. Each instance executes the same run body with a
 * local Checkpointer over its own stored results, so it can be replayed. An
 * eviction interrupts the execution and leaves the instance running until
 * `replay`.
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
    options.onEvent?.(instance, { type: "execution" });
    const checkpointer = localCheckpointer(instance.checkpoints, {
      ...options.checkpointer,
      interruptBefore: (name) =>
        options.interruptBefore?.(instance, name) ?? false,
      onEvent: (event) => options.onEvent?.(instance, event),
    });
    const settled = Effect.runPromiseExit(
      execute(instance.params, checkpointer),
    ).then((exit) => {
      if (Exit.isSuccess(exit)) {
        instance.status = "complete";
      } else if (!Cause.hasInterruptsOnly(exit.cause)) {
        instance.status = "errored";
        const failure = Cause.findErrorOption(exit.cause);
        instance.error =
          failure._tag === "Some" ? failure.value : Cause.squash(exit.cause);
      }
      // Interrupted: evicted, so it stays running until replayed.
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
