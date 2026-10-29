import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const pages = data();
  const [{ calculation, runs }, portfolios] = await loaded(
    Promise.all([pages.calculation(params.id), pages.portfolios()]),
  );
  return { calculation, runs, portfolios };
};
