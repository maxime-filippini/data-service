import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const pages = data();
  const [calculations, portfolios] = await loaded(Promise.all([pages.calculations(), pages.portfolios()]));
  return { calculations, portfolios };
};
