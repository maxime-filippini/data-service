import { data, loaded } from "#lib/server/data.ts";
import { holdingSymbols } from "#lib/server/symbols.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const pages = data();
  const [portfolios, symbols] = await loaded(Promise.all([pages.portfolios(), pages.symbols()]));
  return { portfolios, symbols: holdingSymbols(symbols) };
};
