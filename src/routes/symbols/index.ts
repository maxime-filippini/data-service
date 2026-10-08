import { Effect, Layer, Result, Schema } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  managementToken,
  type ManagementTokenBindings,
} from "$/auth/management-token";
import { effectValidator } from "$/effect-validator";
import {
  RegisterSymbolSchema,
  SymbolRegistry,
  type SymbolRegistryError,
} from "$/market-data/symbol-registry";
import { MarketSymbolSchema } from "$/market-data/schemas";
import { requireBearerToken } from "$/middleware/require-bearer-token";

export type SymbolBindings = CloudflareBindings & ManagementTokenBindings;

const QuerySchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Literals(["true", "false"])),
  limit: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-9][0-9]|100)$/u)),
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});

const CursorSchema = Schema.Struct({
  version: Schema.Literal(2),
  after: Schema.Struct({
    symbol: MarketSymbolSchema,
    provider: Schema.NonEmptyString,
  }),
  enabled: Schema.NullOr(Schema.Boolean),
});

const invalidCursor = () =>
  new HTTPException(400, {
    res: Response.json(
      { error: "Invalid cursor for this enabled filter" },
      { status: 400 },
    ),
  });

const decodeCursor = (
  cursor: string | undefined,
  enabled: boolean | undefined,
) => {
  if (cursor === undefined) return undefined;
  try {
    const result = Schema.decodeUnknownResult(CursorSchema, {
      onExcessProperty: "error",
    })(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          Uint8Array.from(
            atob(cursor.replace(/-/gu, "+").replace(/_/gu, "/")),
            (character) => character.charCodeAt(0),
          ),
        ),
      ),
    );
    if (
      Result.isFailure(result) ||
      result.success.enabled !== (enabled ?? null)
    )
      throw invalidCursor();
    return result.success.after;
  } catch {
    throw invalidCursor();
  }
};

const registryException = (error: SymbolRegistryError) => {
  const status = error.kind === "not_found" ? 404 : 500;
  return new HTTPException(status, {
    res: Response.json(
      { error: error.message, symbol: error.symbol ?? null },
      { status },
    ),
  });
};

export const createSymbolRoutes = (
  registryForBindings: (
    bindings: SymbolBindings,
  ) => Layer.Layer<SymbolRegistry>,
) => {
  const app = new Hono<{ Bindings: SymbolBindings }>();
  app.use(
    "*",
    requireBearerToken<{ Bindings: SymbolBindings }>(managementToken),
  );

  const execute = async <A>(
    env: SymbolBindings,
    program: Effect.Effect<A, SymbolRegistryError, SymbolRegistry>,
  ) => {
    const result = await program.pipe(
      Effect.provide(registryForBindings(env)),
      Effect.result,
      Effect.runPromise,
    );
    if (Result.isFailure(result)) throw registryException(result.failure);
    return result.success;
  };

  app.post(
    "/",
    effectValidator("json", RegisterSymbolSchema, {
      onExcessProperty: "error",
    }),
    async (c) => {
      const input = c.req.valid("json");
      const result = await execute(
        c.env,
        SymbolRegistry.pipe(
          Effect.flatMap((registry) =>
            registry.register(input, new Date().toISOString()),
          ),
        ),
      );
      return c.json(result.symbol, result.created ? 201 : 200);
    },
  );

  app.get(
    "/",
    effectValidator("query", QuerySchema, { onExcessProperty: "error" }),
    async (c) => {
      const query = c.req.valid("query");
      const enabled =
        query.enabled === undefined ? undefined : query.enabled === "true";
      const after = decodeCursor(query.cursor, enabled);
      const limit = Number(query.limit ?? 50);
      const rows = await execute(
        c.env,
        SymbolRegistry.pipe(
          Effect.flatMap((registry) =>
            registry.list({ enabled, after, limit: limit + 1 }),
          ),
        ),
      );
      const symbols = rows.slice(0, limit);
      const last = symbols[symbols.length - 1];
      const nextCursor =
        rows.length > limit
          ? btoa(
              Array.from(
                new TextEncoder().encode(
                  JSON.stringify({
                    version: 2,
                    after: { symbol: last.symbol, provider: last.provider },
                    enabled: enabled ?? null,
                  }),
                ),
                (byte) => String.fromCharCode(byte),
              ).join(""),
            )
              .replace(/\+/gu, "-")
              .replace(/\//gu, "_")
              .replace(/=+$/u, "")
          : null;
      return c.json({ symbols, nextCursor });
    },
  );

  app.post(
    "/:symbol/providers/:provider/disable",
    effectValidator(
      "param",
      Schema.Struct({
        symbol: MarketSymbolSchema,
        provider: Schema.NonEmptyString,
      }),
    ),
    async (c) => {
      const identity = c.req.valid("param");
      const result = await execute(
        c.env,
        SymbolRegistry.pipe(
          Effect.flatMap((registry) =>
            registry.disable(identity, new Date().toISOString()),
          ),
        ),
      );
      return c.json(result);
    },
  );
  return app;
};
