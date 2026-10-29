import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

// The Parquet file itself is fetched and decoded in the browser.
export const load: PageServerLoad = async () => {
  const pages = data();
  const [symbols, calculations] = await loaded(Promise.all([pages.symbols(), pages.calculations()]));
  return { symbols, calculations };
};
