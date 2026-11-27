import { Context, Effect, Layer } from "effect";

import { MarketDataError, PriceProvider } from "$/market-data";
import { EodhdPriceProviderLive } from "$/market-data/eodhd";

/** Selects the download adapter for a registered provider. */
export type SourceFor = (
  provider: string,
) => Layer.Layer<PriceProvider, MarketDataError>;

/** A provider with no adapter: a configuration failure, not a retryable one. */
export const unknownProvider = (provider: string) =>
  Layer.effect(
    PriceProvider,
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
      ? EodhdPriceProviderLive(env.EODHD_API_TOKEN)
      : unknownProvider(provider);

/**
 * Injectable provider selection for workflow steps. The Worker uses the live
 * provider integrations; tests and the fixture command inject adapters that
 * answer from fixture data.
 */
export class PriceProviders extends Context.Service<
  PriceProviders,
  { readonly sourceFor: SourceFor }
>()("data-service/PriceProviders") {}

/** Provider selection from a `SourceFor` function. */
export const PriceProvidersLayer = (sourceFor: SourceFor) =>
  Layer.succeed(PriceProviders, PriceProviders.of({ sourceFor }));
