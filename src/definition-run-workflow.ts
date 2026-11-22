import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Effect, Layer } from "effect";

import { cloudflareServices } from "$/dependencies";
import {
  CloudflareCheckpointerLive,
  runInstanceBody,
} from "$/workflows/cloudflare";
import { executeWorkflowRun } from "$/workflows/executor";
import type { WorkflowRunParams } from "$/workflows/runs/contracts";

/**
 * One run of a workflow definition for one subject. The instance ID is the
 * run ID. The logic lives in `executeWorkflowRun`; this class only provides
 * the Cloudflare services and the instance's `step` as the Checkpointer.
 */
export class DefinitionRunWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  WorkflowRunParams
> {
  override async run(
    event: WorkflowEvent<WorkflowRunParams>,
    step: WorkflowStep,
  ) {
    const layer = Layer.merge(
      cloudflareServices(this.env),
      CloudflareCheckpointerLive(
        step,
        (message) => new NonRetryableError(message),
      ),
    );
    return runInstanceBody(
      executeWorkflowRun(event.payload).pipe(Effect.provide(layer)),
    );
  }
}
