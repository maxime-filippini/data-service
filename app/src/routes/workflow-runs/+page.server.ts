import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url }) => {
  const symbol = url.searchParams.get("symbol") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const trigger = url.searchParams.get("trigger") ?? undefined;
  return {
    runs: await loaded(data().workflowRuns({ symbol, status, trigger })),
  };
};
