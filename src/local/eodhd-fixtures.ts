import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { EodhdMarketDataSource } from "$/market-data/eodhd";
import { type SourceFor, unknownProvider } from "$/market-data/sources";

/** Fixture rows (as EODHD returns them) by symbol. */
export type EodhdFixtures = ReadonlyMap<string, readonly unknown[]>;

/** A placeholder token: fixture runs need no live credentials. */
export const FIXTURE_TOKEN = "fixture-token";

/**
 * Read every `<SYMBOL>.json` file in a directory: each holds an array of
 * end-of-day rows in EODHD's response format.
 */
export const loadEodhdFixtures = (directory: string): EodhdFixtures =>
  new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [
        basename(name, ".json"),
        JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown[],
      ]),
  );

/**
 * Answer an EODHD end-of-day request from fixtures: the symbol's rows within
 * the requested `from`/`to` range, or 404 for an unknown symbol.
 */
export const fixtureEodhdResponse = (
  fixtures: EodhdFixtures,
  url: URL,
): Response => {
  const symbol = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  const rows = fixtures.get(symbol);
  if (rows === undefined)
    return new Response("Ticker not found", { status: 404 });
  const from = url.searchParams.get("from") ?? "0000-00-00";
  const to = url.searchParams.get("to") ?? "9999-99-99";
  return Response.json(
    rows.filter((row) => {
      const date = (row as { date?: unknown }).date;
      return typeof date !== "string" || (date >= from && date <= to);
    }),
  );
};

/**
 * Provider selection backed by the real EODHD adapter, whose HTTP client
 * answers from fixtures instead of the network. Requests still go through
 * the adapter's URL building and raw-data validation. `respond` can
 * override a response, for example to simulate an outage.
 */
export const fixtureSourceFor = (
  fixtures: EodhdFixtures,
  respond: (url: URL) => Response | undefined = () => undefined,
): SourceFor => {
  const client = HttpClient.make((request, url) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        respond(url) ?? fixtureEodhdResponse(fixtures, url),
      ),
    ),
  );
  const eodhd = EodhdMarketDataSource(FIXTURE_TOKEN).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return (provider) =>
    provider === "eodhd" ? eodhd : unknownProvider(provider);
};
