import type { Asset } from "../../../../src/assets/views";
import type { SymbolStatusView } from "#lib/api.ts";

/** Workflow assets and legacy prices_eod symbols suggested by the holdings editor. */
export const holdingSymbols = (
  symbols: readonly SymbolStatusView[],
  assets: readonly Asset[],
) =>
  [
    ...new Set([
      ...assets.map(({ symbol }) => symbol),
      ...symbols.filter((s) => s.dataset === "prices_eod").map((s) => s.symbol),
    ]),
  ].sort();
