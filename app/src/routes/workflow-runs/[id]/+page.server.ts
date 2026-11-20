import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => ({
  run: await loaded(data().workflowRun(params.id)),
});
