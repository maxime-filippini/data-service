import { data, loaded } from "#lib/server/data.ts";
import { holdingSymbols } from "#lib/server/symbols.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => {
  const pages = data();
  const manage = url.searchParams.get("edit") === "1";
  if (!manage) {
    const detail = await loaded(pages.portfolioDetail(params.id));
    return { ...detail, manage, symbols: [] };
  }
  const [portfolio, symbols, assets] = await loaded(
    Promise.all([pages.portfolio(params.id), pages.symbols(), pages.assets()]),
  );
  return {
    portfolio,
    manage,
    symbols: holdingSymbols(symbols, assets),
    assignments: [],
  };
};
