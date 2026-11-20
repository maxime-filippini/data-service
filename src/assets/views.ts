// Assets as the API returns them. This file has no imports so the app can
// import its types directly.

/**
 * An instrument identified by its symbol, such as `AAPL.US`. Datasets are not
 * part of its identity. `provider` and `backfillStartDate` are the download
 * settings its workflows read; `enabled` pauses the asset without deleting it.
 */
export interface Asset {
  readonly symbol: string;
  readonly provider: string;
  readonly backfillStartDate: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
