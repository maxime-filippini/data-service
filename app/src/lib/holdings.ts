import type { HoldingView } from "./api";

/** A holdings row being edited. The weight stays text until it's saved. */
export type HoldingRow = { symbol: string; weight: string };

export const emptyRow = (): HoldingRow => ({ symbol: "", weight: "" });

export const toRows = (holdings: readonly HoldingView[]): HoldingRow[] =>
  holdings.map((holding) => ({ symbol: holding.symbol, weight: String(holding.weight) }));

/**
 * Rows pasted from a spreadsheet or CSV: a symbol and a weight per line,
 * separated by tabs, commas, semicolons or spaces. Lines whose weight isn't a
 * number, such as a header, are skipped and returned.
 */
export const parsePasted = (text: string) => {
  const rows: HoldingRow[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [symbol = "", weight = ""] = trimmed.split(/[\t,;]+|\s+/u);
    if (symbol === "" || weight === "" || !Number.isFinite(Number(weight))) skipped.push(trimmed);
    else rows.push({ symbol: symbol.toUpperCase(), weight });
  }
  return { rows, skipped };
};

/** The rows as holdings, or the first problem found. Blank rows are ignored. */
export const toHoldings = (rows: readonly HoldingRow[]): { holdings: HoldingView[] } | { error: string } => {
  const filled = rows.filter((row) => row.symbol.trim() !== "" || row.weight.trim() !== "");
  if (filled.length === 0) return { error: "Add at least one holding." };
  const seen = new Set<string>();
  const holdings: HoldingView[] = [];
  for (const row of filled) {
    const symbol = row.symbol.trim().toUpperCase();
    const weight = Number(row.weight.trim());
    if (symbol === "") return { error: `A row with weight ${row.weight} has no symbol.` };
    if (row.weight.trim() === "" || !Number.isFinite(weight)) return { error: `${symbol}: the weight must be a number.` };
    if (weight === 0) return { error: `${symbol}: the weight must be non-zero.` };
    if (seen.has(symbol)) return { error: `${symbol} appears more than once.` };
    seen.add(symbol);
    holdings.push({ symbol, weight });
  }
  return { holdings };
};

/** Sum of the weights, for a quick check against 1. */
export const totalWeight = (holdings: readonly { weight: number }[]) =>
  holdings.reduce((sum, holding) => sum + holding.weight, 0);
