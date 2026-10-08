import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";
import test from "node:test";
import { Effect, Layer } from "effect";
import { D1SymbolRegistryLive } from "$/market-data/symbol-registry/d1";
import { SymbolRegistry, SymbolRegistryError, type TrackedSymbol } from "$/market-data/symbol-registry";
import { createSymbolRoutes, type SymbolBindings } from "$/routes/symbols";
import { createProcessingRoutes, type ProcessingJobBindings } from "$/routes/processing";

const configuration = { symbol: "AAPL.US", provider: "eodhd", enabled: true, backfillStartDate: "2016-01-01" };
const firstTime = "2026-10-01T01:00:00.000Z";
const laterTime = "2026-10-02T01:00:00.000Z";

// Execute the production adapter's prepared SQL against SQLite, including transactional batches.
function harness() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of ["0001_initial_market_data_control_plane.sql", "0002_tracked_symbols.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const statement = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...bindings: SQLInputValue[]) => statement(sql, bindings),
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    execute: () => {
      const prepared = sqlite.prepare(sql);
      if (prepared.columns().length > 0) return { results: prepared.all(...values), meta: { changes: 0 } };
      const result = prepared.run(...values);
      return { results: [], meta: { changes: Number(result.changes) } };
    },
  });
  const database = {
    prepare: statement,
    batch: async (statements: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((query) => query.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const layer = D1SymbolRegistryLive(database);
  const registry = Effect.runSync(SymbolRegistry.pipe(Effect.provide(layer)));
  const app = createSymbolRoutes(() => layer);
  const env = { MANAGEMENT_API_TOKEN: "management", PROCESSING_API_TOKEN: "processing" } as SymbolBindings;
  const request = (path: string, method = "GET", body?: unknown, token = "management") => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  return { sqlite, registry, request, app, env };
}

test("registry transitions are idempotent and preserve creation time and execution history", async () => {
  const { sqlite, registry } = harness();
  try {
    sqlite.exec(`INSERT INTO ingestion_runs (run_id, provider, symbol, requested_from, requested_to, status, created_at)
      VALUES ('run', 'eodhd', 'AAPL.US', '2016-01-01', '2026-09-30', 'raw_complete', '2026-10-01');
      INSERT INTO canonical_datasets (symbol, object_key, object_etag, revision)
      VALUES ('AAPL.US', 'data.parquet', 'etag', 5);
      INSERT INTO processing_jobs (job_id, symbol, mode, canonical_key, transform_version, status, created_at)
      VALUES ('job', 'AAPL.US', 'rebuild', 'data.parquet', 'v1', 'processing', '2026-10-01');`);
    const history = () => ["ingestion_runs", "canonical_datasets", "processing_jobs"].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all());
    const originalHistory = history();
    const inserted = await Effect.runPromise(registry.register(configuration, firstTime));
    assert.equal(inserted.created, true);
    const repeated = await Effect.runPromise(registry.register(configuration, laterTime));
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.symbol, inserted.symbol);
    const disabled = await Effect.runPromise(registry.disable(configuration, laterTime));
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.disabledAt, laterTime);
    assert.deepEqual(await Effect.runPromise(registry.disable(configuration, "2026-10-03T00:00:00.000Z")), disabled);
    const updated = await Effect.runPromise(registry.register({ ...configuration, enabled: false, backfillStartDate: "2010-01-01" }, "2026-10-04T00:00:00.000Z"));
    assert.equal(updated.symbol.disabledAt, laterTime);
    const enabled = await Effect.runPromise(registry.register(configuration, "2026-10-05T00:00:00.000Z"));
    assert.equal(enabled.symbol.createdAt, firstTime);
    assert.equal(enabled.symbol.disabledAt, null);
    assert.equal(enabled.symbol.enabled, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tracked_symbols").get()?.count, 1);
    assert.deepEqual(history(), originalHistory);
  } finally { sqlite.close(); }
});

test("management endpoints separate credentials and independently register provider pairs", async () => {
  const { sqlite, request, app, env } = harness();
  try {
    for (const path of ["/", "/AAPL.US/providers/eodhd/disable"]) {
      for (const token of ["processing", "incorrect", ""]) assert.equal((await request(path, "POST", configuration, token)).status, 401);
    }
    assert.equal((await app.request("/", {}, env)).status, 401);
    assert.equal((await app.request("/", { headers: { Authorization: "Bearer management" } }, {} as SymbolBindings)).status, 401);
    assert.equal((await request("/", "GET", undefined, "processing")).status, 401);
    const processing = createProcessingRoutes(() => { throw new Error("Unauthorized request reached service"); });
    assert.equal((await processing.request("/", { method: "POST", headers: { Authorization: "Bearer management" } }, env as ProcessingJobBindings)).status, 401);
    assert.equal((await request("/", "POST", configuration)).status, 201);
    assert.equal((await request("/", "POST", configuration)).status, 200);
    const before = sqlite.prepare("SELECT * FROM tracked_symbols").get();
    assert.equal((await request("/", "POST", { ...configuration, provider: "other", enabled: false })).status, 201);
    assert.deepEqual(sqlite.prepare("SELECT * FROM tracked_symbols WHERE provider = ?").get("eodhd"), before);
    assert.equal((await request("/AAPL.US/providers/eodhd/disable", "POST")).status, 200);
    assert.equal((await request("/UNKNOWN.US/providers/eodhd/disable", "POST")).status, 404);
    assert.equal((await request("/", "POST", configuration)).status, 200);
  } finally { sqlite.close(); }
});

test("registry management accepts new providers without an ingestion adapter or registry changes", async () => {
  const { sqlite, request } = harness();
  try {
    const input = { ...configuration, provider: "new-provider" };
    const inserted = await request("/", "POST", input);
    assert.equal(inserted.status, 201);
    const original = await inserted.json() as TrackedSymbol;
    assert.equal(original.provider, input.provider);
    assert.equal((await request("/", "POST", input)).status, 200);
    const changed = await request("/", "POST", { ...input, backfillStartDate: "2010-01-01" });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json() as TrackedSymbol).backfillStartDate, "2010-01-01");
    assert.equal((await request("/AAPL.US/providers/new-provider/disable", "POST")).status, 200);
    const enabled = await request("/", "POST", input);
    assert.equal(enabled.status, 200);
    const restored = await enabled.json() as TrackedSymbol;
    assert.equal(restored.createdAt, original.createdAt);
    assert.equal(restored.disabledAt, null);
    assert.equal(restored.provider, input.provider);
    const otherProvider = await request("/", "POST", configuration);
    assert.equal(otherProvider.status, 201);
    const eodhd = await otherProvider.json() as TrackedSymbol;
    const listed = await (await request("/")).json() as { symbols: TrackedSymbol[] };
    assert.deepEqual(listed.symbols, [eodhd, restored]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_runs").get()?.count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()?.count, 0);
  } finally { sqlite.close(); }
});

test("disabling and re-enabling one provider leaves the other provider configuration unchanged", async () => {
  const { sqlite, registry, request } = harness();
  try {
    const original = await Effect.runPromise(registry.register(configuration, firstTime));
    const other = { ...configuration, provider: "other", backfillStartDate: "2020-01-01" };
    const alternate = await Effect.runPromise(registry.register(other, laterTime));
    assert.equal(alternate.created, true);
    const response = await request("/AAPL.US/providers/eodhd/disable", "POST");
    assert.equal(response.status, 200);
    const disabled = await response.json() as TrackedSymbol;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.provider, "eodhd");
    const readOther = await Effect.runPromise(registry.register(other, laterTime));
    assert.deepEqual(readOther.symbol, alternate.symbol);
    const repeated = await request("/AAPL.US/providers/eodhd/disable", "POST");
    assert.deepEqual(await repeated.json(), disabled);
    assert.equal((await request("/AAPL.US/providers/missing/disable", "POST")).status, 404);
    assert.equal((await request("/AAPL.US/disable", "POST")).status, 404);
    const restored = await Effect.runPromise(registry.register(configuration, laterTime));
    assert.equal(restored.created, false);
    assert.equal(restored.symbol.createdAt, original.symbol.createdAt);
    assert.equal(restored.symbol.disabledAt, null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tracked_symbols").get()?.count, 2);
    assert.throws(() => sqlite.prepare(`INSERT INTO tracked_symbols
      SELECT * FROM tracked_symbols WHERE provider = 'eodhd'`).run(), /UNIQUE constraint/);
  } finally { sqlite.close(); }
});

test("registry accepts symbols with or without an exchange suffix for registration and disable", async () => {
  const { sqlite, request } = harness();
  try {
    for (const symbol of ["AAPL", "AAPL.US", "BRK-B", "BRK-B.US"]) {
      const response = await request("/", "POST", { ...configuration, symbol });
      assert.equal(response.status, 201);
      assert.equal((await response.json() as TrackedSymbol).symbol, symbol);
      const disabled = await request(`/${symbol}/providers/eodhd/disable`, "POST");
      assert.equal(disabled.status, 200);
      assert.equal((await disabled.json() as TrackedSymbol).enabled, false);
    }
  } finally { sqlite.close(); }
});

test("management validation rejects invalid configuration and malformed JSON before writes", async () => {
  const { sqlite, request, app, env } = harness();
  try {
    for (const body of [
      { ...configuration, symbol: "AAPL." }, { ...configuration, symbol: "aapl.US" },
      { ...configuration, symbol: "../AAPL.US" }, { ...configuration, symbol: "AAPL.US/extra" },
      { ...configuration, provider: "" }, { ...configuration, enabled: 1 },
      { ...configuration, backfillStartDate: "2025-02-29" }, { ...configuration, backfillStartDate: "2024-13-01" },
      { ...configuration, backfillStartDate: "2999-01-01" }, { ...configuration, extra: true },
      { symbol: "AAPL.US" }, null, [],
    ]) assert.equal((await request("/", "POST", body)).status, 400, JSON.stringify(body));
    assert.equal((await app.request("/", { method: "POST", headers: { Authorization: "Bearer management", "Content-Type": "application/json" }, body: "{" }, env)).status, 400);
    assert.equal((await request("/bad/providers/eodhd/disable", "POST")).status, 400);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tracked_symbols").get()?.count, 0);
    assert.equal((await request("/", "POST", { ...configuration, backfillStartDate: "2024-02-29", enabled: false })).status, 201);
    const row = sqlite.prepare("SELECT * FROM tracked_symbols").get();
    assert.equal(row?.disabled_at, row?.created_at);
    assert.equal((await request("/", "POST", { ...configuration, backfillStartDate: new Date().toISOString().slice(0, 10) })).status, 200);
  } finally { sqlite.close(); }
});

test("registry pagination covers all rows in symbol order and binds cursors to filters", async () => {
  const { sqlite, registry, request } = harness();
  try {
    for (let index = 104; index >= 0; index--) {
      await Effect.runPromise(registry.register({ ...configuration, symbol: `S${String(index).padStart(3, "0")}.US`, enabled: index % 2 === 0 }, firstTime));
    }
    const expected = Array.from({ length: 105 }, (_, index) => `S${String(index).padStart(3, "0")}.US`);
    for (const filter of ["", "true", "false"]) {
      let cursor: string | null = null;
      const seen: string[] = [];
      do {
        const params = new URLSearchParams({ limit: "7" });
        if (filter) params.set("enabled", filter);
        if (cursor) params.set("cursor", cursor);
        const response = await request(`/?${params}`);
        assert.equal(response.status, 200);
        const page = await response.json() as { symbols: TrackedSymbol[]; nextCursor: string | null };
        seen.push(...page.symbols.map((row) => row.symbol));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, expected.filter((_, index) => !filter || (index % 2 === 0) === (filter === "true")));
    }
    const defaultPage = await (await request("/")).json() as { symbols: TrackedSymbol[]; nextCursor: string };
    assert.equal(defaultPage.symbols.length, 50);
    assert.equal((await request(`/?enabled=true&cursor=${defaultPage.nextCursor}`)).status, 400);
    assert.equal((await request("/?limit=100")).status, 200);
    for (const query of ["limit=0", "limit=101", "limit=1.5", "enabled=1", "cursor=bad", "extra=1", "cursor="]) {
      assert.equal((await request(`/?${query}`)).status, 400, query);
    }
  } finally { sqlite.close(); }
});

test("pagination includes every provider at page boundaries sharing the same symbol", async () => {
  const { sqlite, registry, request } = harness();
  try {
    const entries = [
      { symbol: "AAPL", provider: "a", enabled: true },
      { symbol: "AAPL", provider: "b", enabled: false },
      { symbol: "AAPL", provider: "café", enabled: true },
      { symbol: "MSFT.US", provider: "a", enabled: false },
      { symbol: "MSFT.US", provider: "b", enabled: true },
    ];
    for (const entry of [...entries].reverse()) {
      await Effect.runPromise(registry.register({ ...configuration, ...entry }, firstTime));
    }
    for (const enabled of [undefined, true, false]) {
      let cursor: string | null = null;
      const seen: { symbol: string; provider: string; enabled: boolean }[] = [];
      do {
        const query = new URLSearchParams({ limit: "1" });
        if (enabled !== undefined) query.set("enabled", String(enabled));
        if (cursor !== null) query.set("cursor", cursor);
        const response = await request(`/?${query}`);
        assert.equal(response.status, 200);
        const page = await response.json() as { symbols: TrackedSymbol[]; nextCursor: string | null };
        seen.push(...page.symbols.map(({ symbol, provider, enabled }) => ({ symbol, provider, enabled })));
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.deepEqual(seen, entries.filter((entry) => enabled === undefined || entry.enabled === enabled));
    }
    const legacyCursor = btoa(JSON.stringify({ version: 1, after: "AAPL.US", enabled: null }));
    assert.equal((await request(`/?cursor=${encodeURIComponent(legacyCursor)}`)).status, 400);
  } finally { sqlite.close(); }
});

test("database failures return sanitized server errors", async () => {
  const failure = () => Effect.fail(new SymbolRegistryError({ kind: "database", message: "Could not access the symbol registry" }));
  const app = createSymbolRoutes(() => Layer.succeed(SymbolRegistry, SymbolRegistry.of({ register: failure, list: failure, disable: failure })));
  const response = await app.request("/", { headers: { Authorization: "Bearer management" } }, { MANAGEMENT_API_TOKEN: "management" } as SymbolBindings);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Could not access the symbol registry", symbol: null });
});

test("the D1 adapter sanitizes database exceptions and the migration enforces registry constraints", async () => {
  const { sqlite, request } = harness();
  const insert = sqlite.prepare(`INSERT INTO tracked_symbols
    (symbol, provider, enabled, backfill_start_date, created_at, updated_at, disabled_at)
    VALUES ('AAPL.US', ?, ?, '2016-01-01', ?, ?, ?)`);
  assert.throws(() => insert.run("", 1, firstTime, firstTime, null), /CHECK constraint/);
  assert.throws(() => insert.run("eodhd", 2, firstTime, firstTime, null), /CHECK constraint/);
  assert.throws(() => insert.run("eodhd", 0, firstTime, firstTime, null), /CHECK constraint/);
  sqlite.close();
  for (const [path, method, body] of [["/", "GET", undefined], ["/", "POST", configuration], ["/AAPL.US/providers/eodhd/disable", "POST", undefined]] as const) {
    const response = await request(path, method, body);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Could not access the symbol registry", symbol: null });
  }
});
