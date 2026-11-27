/**
 * The reference forms an input binding can use. A reference names a
 * run-context field or a named output of an earlier step; it is not an
 * expression and cannot traverse into a value.
 */

import { Option, Schema } from "effect";

import { StepIdSchema } from "$/workflows/contracts";

/** A run-context field or port name: a letter, then letters, digits or `_`. */
const NameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/u),
);

/** A parsed `{ "ref": ... }` binding. Step IDs follow `StepIdSchema`. */
export const ReferenceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("context"), field: NameSchema }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    step: StepIdSchema,
    output: NameSchema,
  }),
]);

export type Reference = typeof ReferenceSchema.Type;

const decodeReference = Schema.decodeUnknownOption(ReferenceSchema);

/**
 * Split `context.<field>` or `steps.<step>.outputs.<output>` into its parts.
 * Neither form allows a `.` inside a part, so splitting on `.` is exact; the
 * parts are validated by decoding them with `ReferenceSchema`.
 */
const splitReference = (ref: string) => {
  const parts = ref.split(".");
  if (parts.length === 2 && parts[0] === "context")
    return { kind: "context", field: parts[1] };
  if (parts.length === 4 && parts[0] === "steps" && parts[2] === "outputs")
    return { kind: "output", step: parts[1], output: parts[3] };
  return undefined;
};

/** Parse a reference, or undefined when it has neither form. */
export const parseReference = (ref: string): Reference | undefined =>
  Option.getOrUndefined(decodeReference(splitReference(ref)));

/** The reference string for an earlier step's output. */
export const outputReference = (step: string, output: string) =>
  `steps.${step}.outputs.${output}`;
