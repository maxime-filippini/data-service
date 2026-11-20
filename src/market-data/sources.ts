import { Context, Effect, Layer } from "effect";

import { MarketDataError, MarketDataSource } from "$/market-data";
import { EodhdMarketDataSourceLive } from "$/market-data/eodhd";

/** Selects the download adapter for a registered provider. */
export type SourceFor = (
  provider: string,
) => Layer.Layer<MarketDataSource, MarketDataError>;

/** A provider with no adapter: a configuration failure, not a retryable one. */
export const unknownProvider = (provider: string) =>
  Layer.effect(
    MarketDataSource,
    Effect.fail(
      new MarketDataError({
        kind: "configuration",
        message: `Unknown provider ${provider}`,
      }),
    ),
  );

/** The live adapter for each provider, with its credentials from bindings. */
export const liveSourceFor =
  (env: Pick<CloudflareBindings, "EODHD_API_TOKEN">): SourceFor =>
  (provider) =>
    provider === "eodhd"
      ? EodhdMarketDataSourceLive(env.EODHD_API_TOKEN)
      : unknownProvider(provider);

/**
 * Injectable provider selection for workflow steps. The Worker uses the live
 * provider integrations; tests and the fixture command inject adapters that
 * answer from fixture data.
 */
export class MarketDataSources extends Context.Service<
  MarketDataSources,
  { readonly sourceFor: SourceFor }
>()("data-service/MarketDataSources") {}

/** Provider selection from a `SourceFor` function. */
export const MarketDataSourcesLayer = (sourceFor: SourceFor) =>
  Layer.succeed(MarketDataSources, MarketDataSources.of({ sourceFor }));
