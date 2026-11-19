import { Context, type Effect } from "effect";

import type { Asset, AssetError, CreateAsset, UpdateAsset } from "./contracts";

/**
 * Injectable asset persistence. `D1AssetsLive` stores assets by symbol;
 * removing an asset also removes its workflow assignments in the same batch.
 * Run history and published data are not touched by these operations.
 */
export class Assets extends Context.Service<
  Assets,
  {
    /** Every asset, by symbol. */
    readonly list: () => Effect.Effect<readonly Asset[], AssetError>;
    readonly get: (symbol: string) => Effect.Effect<Asset, AssetError>;
    /** A `conflict` if the symbol already exists. */
    readonly create: (
      input: CreateAsset,
      now: string,
    ) => Effect.Effect<Asset, AssetError>;
    readonly update: (
      symbol: string,
      input: UpdateAsset,
      now: string,
    ) => Effect.Effect<Asset, AssetError>;
    /** Delete the asset and its workflow assignments. */
    readonly remove: (symbol: string) => Effect.Effect<void, AssetError>;
  }
>()("data-service/Assets") {}
