import { type CalculationTypeInfo, fetchCalculationTypes } from "./api";

// The engine container may be starting up, so the types load in the browser,
// after the page, and are kept for the session. Only ever loaded from effects,
// so this state is never shared between server requests.
let types = $state<readonly CalculationTypeInfo[]>([]);
let error = $state<string | null>(null);
let request: Promise<void> | null = null;

export const calculationTypes = {
  get list() {
    return types;
  },
  get error() {
    return error;
  },
  /** Load the types unless they're loaded or loading. `retry` tries again after a failure. */
  load({ retry = false } = {}) {
    if (types.length > 0 || (request !== null && !retry)) return request ?? Promise.resolve();
    error = null;
    request = fetchCalculationTypes()
      .then((result) => {
        types = result.types;
      })
      .catch((cause) => {
        error = `Could not load calculation types from the engine: ${cause instanceof Error ? cause.message : String(cause)}`;
      });
    return request;
  },
};
