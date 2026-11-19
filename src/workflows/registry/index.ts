import { Context, Layer, Schema } from "effect";

import type { SubjectKind } from "$/workflows/contracts";
import type {
  ContractView,
  JsonSchemaView,
  PortView,
  StepCatalog,
} from "$/workflows/views";

import type { Contract } from "./contract";
import { downloadPrices } from "./download-prices";
import { normalizePrices } from "./normalize-prices";
import { publishDataset } from "./publish-dataset";
import { type Ports, runContextFields, type StepType } from "./step-type";

export * from "./contract";
export * from "./step-type";

/** The step types the service ships, in catalog order. */
export const builtInStepTypes: readonly StepType[] = [
  downloadPrices,
  normalizePrices,
  publishDataset,
];

/**
 * The step types definitions can use, by type name. Validation, inspection,
 * the catalog and the executor all read the same registry.
 */
export interface StepTypes {
  readonly get: (type: string) => StepType | undefined;
  readonly all: readonly StepType[];
}

/** Build a registry; fails fast on a repeated type name or contract ID. */
export const makeStepTypes = (stepTypes: readonly StepType[]): StepTypes => {
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
export class StepRegistry extends Context.Service<StepRegistry, StepTypes>()(
  "data-service/StepRegistry",
) {}

/** A layer providing a registry of the given step types. */
export const StepRegistryLayer = (stepTypes: readonly StepType[]) =>
  Layer.succeed(StepRegistry, StepRegistry.of(makeStepTypes(stepTypes)));

/** The service's registry. */
export const StepRegistryLive = StepRegistryLayer(builtInStepTypes);

const jsonSchema = (schema: Schema.Top): JsonSchemaView => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

const ports = (named: Ports): PortView[] =>
  Object.entries(named).map(([name, port]) => ({
    name,
    contract: port.contract.id,
    description: port.description,
  }));

const SCOPES: readonly SubjectKind[] = ["asset", "portfolio"];

/** The catalog of a registry: step types, contracts and run-context fields. */
export const stepCatalog = (registry: StepTypes): StepCatalog => {
  const contracts = new Map<string, Contract<any>>();
  const collect = (contract: Contract<any>) =>
    contracts.set(contract.id, contract);
  for (const field of Object.values(runContextFields))
    for (const scope of SCOPES) collect(field.contract(scope));
  for (const stepType of registry.all)
    for (const port of [
      ...Object.values(stepType.inputs),
      ...Object.values(stepType.outputs),
    ])
      collect(port.contract);

  return {
    stepTypes: registry.all.map((stepType) => ({
      type: stepType.type,
      description: stepType.description,
      scopes: stepType.scopes,
      params: jsonSchema(stepType.params),
      inputs: ports(stepType.inputs),
      outputs: ports(stepType.outputs),
    })),
    contracts: [...contracts.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((contract): ContractView => ({
        id: contract.id,
        description: contract.description,
        schema: jsonSchema(contract.schema),
      })),
    context: Object.entries(runContextFields).map(([field, definition]) => ({
      field,
      description: definition.description,
      contracts: {
        asset: definition.contract("asset").id,
        portfolio: definition.contract("portfolio").id,
      },
    })),
  };
};
