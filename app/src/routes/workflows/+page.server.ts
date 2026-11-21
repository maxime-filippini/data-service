import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const [workflows, defaults] = await Promise.all([
    loaded(data().workflows()),
    loaded(data().workflowDefaults()),
  ]);
  return { workflows, defaults };
};
