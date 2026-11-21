/**
 * The step catalog: the registry described for API clients. This module maps
 * registry entries to the response types in `views.ts`; the registry itself
 * knows nothing of them.
 */

import { toJsonSchema } from "$/schema";
import {
  type Contract,
  type Ports,
  runContextFields,
  type StepTypeRegistry,
} from "$/workflows/registry";
import { SUBJECT_KINDS, type SubjectKind } from "$/workflows/subjects";
import type { ContractView, PortView, StepCatalog } from "$/workflows/views";

const portViews = (ports: Ports): PortView[] =>
  Object.entries(ports).map(([name, port]) => ({
    name,
    contract: port.contract.id,
    description: port.description,
  }));

/** The value of `fn` for every subject kind. */
const bySubjectKind = <A>(fn: (kind: SubjectKind) => A) =>
  Object.fromEntries(SUBJECT_KINDS.map((kind) => [kind, fn(kind)])) as Record<
    SubjectKind,
    A
  >;

/** Every step type, contract and run-context field of a registry. */
export const stepCatalog = (registry: StepTypeRegistry): StepCatalog => {
  const contracts = new Map<string, Contract<any>>();
  const collect = (contract: Contract<any>) =>
    contracts.set(contract.id, contract);
  for (const field of Object.values(runContextFields))
    for (const kind of SUBJECT_KINDS) collect(field.contract(kind));
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
      params: toJsonSchema(stepType.params),
      inputs: portViews(stepType.inputs),
      outputs: portViews(stepType.outputs),
    })),
    contracts: [...contracts.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((contract): ContractView => ({
        id: contract.id,
        description: contract.description,
        schema: toJsonSchema(contract.schema),
        ...(contract.accepts === undefined
          ? {}
          : { accepts: contract.accepts }),
      })),
    context: Object.entries(runContextFields).map(([field, definition]) => ({
      field,
      description: definition.description,
      contracts: bySubjectKind((kind) => definition.contract(kind).id),
    })),
  };
};
