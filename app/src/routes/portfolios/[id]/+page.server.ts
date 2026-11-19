import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => {
  const pages = data();
  const manage = url.searchParams.get("edit") === "1";
  if (!manage) {
    const detail = await loaded(pages.portfolioDetail(params.id));
    return { ...detail, manage, symbols: [] as string[] };
  }
  const [portfolio, assets] = await loaded(
    Promise.all([pages.portfolio(params.id), pages.assets()]),
  );
  return {
    portfolio,
    manage,
    symbols: assets.map((asset) => asset.symbol),
    assignments: [],
    runs: [],
    publications: [],
  };
};
