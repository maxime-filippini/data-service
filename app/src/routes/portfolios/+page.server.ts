import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const pages = data();
  const [portfolios, assets] = await loaded(
    Promise.all([pages.portfolios(), pages.assets()]),
  );
  return {
    portfolios,
    symbols: assets.map((asset) => asset.symbol),
  };
};
