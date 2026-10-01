import { Effect, Schema } from "effect";
import { Hono } from "hono";

import { effectValidator } from "./effect-validator";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Custom schema types
const PositiveIntFromString = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);

// Schemas
const EchoBody = Schema.Struct({
  message: Schema.NonEmptyString,
  priority: Schema.Literals(["low", "normal", "high"]),
  amount: Schema.Finite.check(Schema.isGreaterThan(0)),
});

const PaginationQuery = Schema.Struct({
  page: PositiveIntFromString.pipe(
    // This is how we provide defaults for the encoded values
    Schema.withDecodingDefaultTypeKey(Effect.succeed(1)),
  ),
  pageSize: PositiveIntFromString.check(Schema.isLessThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(20)),
  ),
});

// Endpoints
// We

app.post("/echo", effectValidator("json", EchoBody), (c) => {
  return c.json(c.req.valid("json"));
});

app.get("/items", effectValidator("query", PaginationQuery), (c) => {
  return c.json({ pagination: c.req.valid("query") });
});

export default app;
