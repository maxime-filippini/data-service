import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const pages = data();
  const [symbols, schedule, scheduleRuns] = await loaded(
    Promise.all([pages.symbols(), pages.schedule(), pages.scheduleRuns(10)]),
  );
  return { symbols, options: pages.options().datasetProviders, schedule, scheduleRuns };
};
