import type { SymbolStatusView } from "#lib/api.ts";

/** Tracked prices_eod symbols, which the holdings editor suggests. */
export const holdingSymbols = (symbols: readonly SymbolStatusView[]) =>
  symbols.filter((s) => s.dataset === "prices_eod").map((s) => s.symbol);
