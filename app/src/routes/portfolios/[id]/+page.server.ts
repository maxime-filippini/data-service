import { data, loaded } from "#lib/server/data.ts";
import { holdingSymbols } from "#lib/server/symbols.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const pages = data();
  const [portfolio, symbols] = await loaded(Promise.all([pages.portfolio(params.id), pages.symbols()]));
  return { portfolio, symbols: holdingSymbols(symbols) };
};
