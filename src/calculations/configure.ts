import { Effect } from "effect";

import {
  CalculationError,
  Calculations,
  type CreateCalculation,
  type UpdateCalculation,
} from "$/calculations";
import { Engine, type CalculationTypeInfo } from "$/calculations/engine";

const invalid = (message: string) => new CalculationError({ kind: "invalid", message });

/** The engine's description of a type. */
const typeInfo = Effect.fn("Calculations.typeInfo")(function* (name: string) {
  const engine = yield* Engine;
  const type = (yield* engine.listTypes()).find((candidate) => candidate.name === name);
  if (type === undefined) return yield* Effect.fail(invalid(`The engine has no calculation type ${name}`));
  return type;
});

/** A type that takes a portfolio needs at least one; other types take none. */
const checkPortfolios = (type: CalculationTypeInfo, portfolioIds: readonly string[]) => {
  if (type.takesPortfolio && portfolioIds.length === 0) {
    return Effect.fail(invalid(`${type.name} runs over portfolios, so the calculation needs at least one`));
  }
  if (!type.takesPortfolio && portfolioIds.length > 0) {
    return Effect.fail(invalid(`${type.name} doesn't take a portfolio`));
  }
  return Effect.void;
};

/**
 * Save a new calculation. The engine checks its params, and the calculation
 * stores them as the engine returned them, with defaults filled in.
 */
export const createCalculation = Effect.fn("Calculations.create")(function* (
  input: CreateCalculation,
  id: string,
  now: string,
) {
  const type = yield* typeInfo(input.type);
  const portfolioIds = input.portfolioIds ?? [];
  yield* checkPortfolios(type, portfolioIds);
  const params = yield* (yield* Engine).validate(type.name, input.params ?? {});
  const store = yield* Calculations;
  return yield* store.create(
    { id, name: input.name, type: type.name, params, portfolioIds, cron: input.cron, enabled: input.enabled ?? true },
    now,
  );
});

/**
 * Change a calculation. The type can't change. New params or portfolios are
 * checked against the type as for a new calculation; earlier runs keep the
 * params they used.
 */
export const updateCalculation = Effect.fn("Calculations.update")(function* (
  id: string,
  patch: UpdateCalculation,
  now: string,
) {
  const store = yield* Calculations;
  const current = yield* store.get(id);
  if (patch.type !== undefined && patch.type !== current.type) {
    return yield* Effect.fail(invalid("A calculation's type can't change; create a new calculation instead"));
  }

  let params = patch.params;
  if (patch.params !== undefined || patch.portfolioIds !== undefined) {
    const type = yield* typeInfo(current.type);
    if (patch.portfolioIds !== undefined) yield* checkPortfolios(type, patch.portfolioIds);
    if (patch.params !== undefined) params = yield* (yield* Engine).validate(type.name, patch.params);
  }

  return yield* store.update(
    id,
    {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(params === undefined ? {} : { params }),
      ...(patch.portfolioIds === undefined ? {} : { portfolioIds: patch.portfolioIds }),
      ...(patch.cron === undefined ? {} : { cron: patch.cron }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    },
    now,
  );
});
