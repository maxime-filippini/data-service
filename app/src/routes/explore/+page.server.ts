import { data, loaded } from "#lib/server/data.ts";

import type { PageServerLoad } from "./$types";

// The Parquet file itself is fetched and decoded in the browser.
export const load: PageServerLoad = async () => {
  const pages = data();
  const [publications, portfolios] = await loaded(
    Promise.all([pages.publications(), pages.portfolios()]),
  );
  return { publications, portfolios };
};
