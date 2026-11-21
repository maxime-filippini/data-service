import { Context, Layer } from "effect";

import type { Contract } from "./contract";
import { calculatePortfolioVolatility } from "./calculate-portfolio-volatility";
import { downloadPrices } from "./download-prices";
import { normalizePrices } from "./normalize-prices";
import { loadPortfolioHoldings } from "./portfolio-holdings";
import { publishDataset } from "./publish-dataset";
import type { StepType } from "./step-type";
import { waitForAssetPublications } from "./wait-for-asset-publications";

export * from "./contract";
export * from "./step-type";

/** The step types the service ships, in catalog order. */
export const builtInStepTypes: readonly StepType[] = [
  downloadPrices,
  normalizePrices,
  publishDataset,
  loadPortfolioHoldings,
  waitForAssetPublications,
  calculatePortfolioVolatility,
];

/**
 * The step types definitions can use, looked up by type name or listed in
 * catalog order. Validation, the workflow detail, the catalog and the
 * executor all read the same registry.
 */
export interface StepTypeRegistry {
  readonly get: (type: string) => StepType | undefined;
  readonly all: readonly StepType[];
}

/** Build a registry; fails fast on a repeated type name or contract ID. */
export const makeStepTypeRegistry = (
  stepTypes: readonly StepType[],
): StepTypeRegistry => {
  const byType = new Map<string, StepType>();
  const contracts = new Map<string, Contract<any>>();
  for (const stepType of stepTypes) {
    if (byType.has(stepType.type))
      throw new Error(`Step type ${stepType.type} is registered twice`);
    byType.set(stepType.type, stepType);
    for (const port of [
      ...Object.values(stepType.inputs),
      ...Object.values(stepType.outputs),
    ]) {
      const known = contracts.get(port.contract.id);
      if (known !== undefined && known !== port.contract)
        throw new Error(`Contract ${port.contract.id} is defined twice`);
      contracts.set(port.contract.id, port.contract);
    }
  }
  return { get: (type) => byType.get(type), all: stepTypes };
};

/** The injectable step registry. */
export class StepRegistry extends Context.Service<
  StepRegistry,
  StepTypeRegistry
>()("data-service/StepRegistry") {}

/** A layer providing a registry of the given step types. */
export const StepRegistryLayer = (stepTypes: readonly StepType[]) =>
  Layer.succeed(StepRegistry, StepRegistry.of(makeStepTypeRegistry(stepTypes)));

/** The service's registry. */
export const StepRegistryLive = StepRegistryLayer(builtInStepTypes);
