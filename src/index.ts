import { dependencies } from "$/dependencies";
import { createRoutes } from "$/routes";
import { runScheduledHandlers } from "$/scheduled";
// SvelteKit's handler, built by `pnpm --filter app build` (wrangler's build
// command runs it before dev and deploy). It has no type declarations.
// @ts-expect-error -- generated JavaScript, missing until the app is built
import sveltekit from "../app/.svelte-kit/cloudflare/_worker.js";

export { DefinitionRunWorkflow } from "./definition-run-workflow";
export { CalculationEngine } from "./engine-container";
export { WorkflowDispatchWorkflow } from "./workflow-dispatch-workflow";
export { runScheduledHandlers } from "$/scheduled";

const app = createRoutes(dependencies, sveltekit);

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    await runScheduledHandlers(
      new Date(controller.scheduledTime),
      env,
      dependencies,
    );
  },
} satisfies ExportedHandler<CloudflareBindings>;
