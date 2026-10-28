# Effect v4 Schema validation at HTTP boundaries

## Recommended shape

Treat request data as `unknown`, define one schema for the wire format and the
decoded domain value, and decode once at the HTTP boundary. Effect's v4 Schema
docs describe decoding as the operation that both validates and transforms the
encoded input into its decoded type; transformed schemas retain distinct
`Encoded` and `Type` types ([Schema introduction](https://effect.website/docs/v4/schema/introduction)).

For a synchronous framework callback such as a Hono validator, construct a
`Schema.decodeUnknownResult` decoder once and call it for each request:

```ts
import { Result, Schema, SchemaIssue } from "effect"

const CreateItemSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  quantity: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
})

const decodeCreateItem = Schema.decodeUnknownResult(CreateItemSchema, {
  errors: "all",
  onExcessProperty: "error",
})

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const result = decodeCreateItem(requestBody)
if (Result.isFailure(result)) {
  const issues = formatIssues(result.failure.issue).issues
  // Translate `issues` to the framework's 400/422 HTTP error here.
} else {
  const item = result.success
}
```

This matches the documented role of `decodeUnknownResult`: untyped input is
decoded synchronously, with schema mismatches returned as data rather than
thrown. It can still throw for defects, interruptions, or asynchronous work, so
it is appropriate only for synchronous, service-free schemas
([getting started](https://effect.website/docs/v4/schema/getting-started),
[`SchemaParser.decodeUnknownResult` source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/SchemaParser.ts)).

If the handler is already an Effect program, or a transformation performs
asynchronous work or needs Effect services, prefer `Schema.decodeUnknownEffect`.
Its service requirements stay visible in the returned Effect and its validation
failure stays in the typed error channel
([`SchemaParser.decodeUnknownEffect` source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/SchemaParser.ts),
[fallible transformations](https://effect.website/docs/v4/schema/transformations#fallible-transformations)).
The `Sync`, `Option`, `Result`, and `Exit` interpreters cannot execute
asynchronous transformations ([decoder overview](https://effect.website/docs/v4/schema/getting-started#decoding)).

There is no need to rebuild a decoder inside every request. The API is
curried—`Schema.decodeUnknownResult(schema, options)` returns the function that
accepts input—and Effect's own examples bind that function once before calling
it. Keeping the schema, decoder, and formatter at module scope also centralizes
the boundary policy.

## Parse and error policy

- Parsing reports only the first issue by default. Use `{ errors: "all" }` when
  an API should return all independent validation failures in one response
  ([error formatters](https://effect.website/docs/v4/schema/error-formatters#handling-multiple-errors)).
- Struct decoding ignores and strips undeclared properties by default. Add
  `{ onExcessProperty: "error" }` when the HTTP contract should reject unknown
  keys; leaving the default is a deliberate permissive-input policy
  ([parse options](https://effect.website/docs/v4/schema/getting-started#parse-options)).
- `SchemaError.message` is the human-readable multiline rendering. For a JSON
  API, `SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues` gives
  stable `{ message, path }` entries suitable for clients
  ([error formatters](https://effect.website/docs/v4/schema/error-formatters#standard-schema-v1-formatter)).
- Avoid `{ reportInput: true }` at a public boundary unless rejected values are
  intentionally safe to disclose. Effect warns that this option can retain or
  expose secrets, personal data, and large object graphs
  ([`ParseOptions` source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/SchemaAST.ts)).

Effect defines the validation error, not the HTTP status or response envelope.
Mapping that error to the framework's HTTP exception at the adapter boundary is
therefore the appropriate integration point. No v4 Schema documentation found
prescribes 400 versus 422.

## Query strings and pagination

Query parameters are encoded strings, so model that conversion in the schema
rather than coercing before validation. `Schema.FiniteFromString` decodes a
string into a finite number; checks then express the pagination constraints
([transformations](https://effect.website/docs/v4/schema/transformations#finitefromstring),
[schema projections example](https://effect.website/docs/v4/schema/projections#totype)):

```ts
const PositivePageSchema = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
)

const PaginationSchema = Schema.Struct({
  page: PositivePageSchema,
  pageSize: PositivePageSchema.check(Schema.isLessThanOrEqualTo(100)),
})
```

Use `FiniteFromString` rather than the broader `NumberFromString` when `NaN` and
infinities should be rejected by the conversion itself. Defaults can also be
part of the decoding schema, so the handler receives the final pagination type
rather than strings or missing keys
([missing-key defaults](https://effect.website/docs/v4/schema/advanced-usage#default-for-a-missing-key)).

When using Effect's HTTP stack directly, its APIs already make this boundary
explicit: `HttpRouter.schemaJson` decodes the request and JSON body, while
`HttpRouter.schemaParams` decodes query parameters
([HttpRouter API](https://effect.website/docs/v4/api/effect/http/HttpRouter)).
The higher-level `HttpApiEndpoint` declarations accept `payload` and `query`
schemas and the builder decodes requests before invoking handlers
([HttpApiEndpoint API](https://effect.website/docs/v4/api/effect/http-api/HttpApiEndpoint),
[HttpApiBuilder API](https://effect.website/docs/v4/api/effect/http-api/HttpApiBuilder)).
With another framework, a small reusable validator adapter provides the same
boundary.

## Is Standard Schema the recommended path?

`Schema.toStandardSchemaV1` is an interoperability adapter: it exposes an
Effect schema to libraries that accept the Standard Schema V1 interface while
retaining the original Effect APIs
([Standard Schema docs](https://effect.website/docs/v4/schema/standard-schema)).
It is relevant when the HTTP framework or validation middleware natively
accepts Standard Schema. It is not required when calling Effect's decoders
directly, and it cannot be used when decoding requires Effect services. Its
validator returns synchronously when it can and a Promise when a transformation
is asynchronous.

Therefore, for the current Hono adapter, direct `decodeUnknownResult` plus the
Standard Schema **issue formatter** is the simpler Effect-native pattern. Use
`toStandardSchemaV1` only if a generic Standard Schema-aware middleware can
replace the custom adapter; converting merely to call its `validate` method
adds an abstraction without adding validation behavior. This last recommendation
is an inference from the documented purpose and restrictions of the adapter,
not an explicit mandate in the Effect docs.

## Assessment of the current implementation

The existing `effectValidator` follows the documented synchronous-boundary
pattern: it creates the decoder once, treats failures as `Result` data, asks for
all issues, formats them into structured paths/messages, and translates them to
an HTTP error. The main policy decision to revisit is whether JSON bodies should
also set `onExcessProperty: "error"`; without it, extra properties are stripped
and accepted by design. The pagination schema's string-to-number transformation
is also the correct shape; `FiniteFromString` would make the finite-number
requirement more explicit before the integer and range checks.
