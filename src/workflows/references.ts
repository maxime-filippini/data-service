/**
 * The reference forms an input binding can use. A reference names a
 * run-context field or a named output of an earlier step; it is not an
 * expression and cannot traverse into a value.
 */

/** A parsed `{ "ref": ... }` binding. */
export type Reference =
  | { readonly kind: "context"; readonly field: string }
  | { readonly kind: "output"; readonly step: string; readonly output: string };

const CONTEXT = /^context\.([A-Za-z][A-Za-z0-9_]*)$/u;

const OUTPUT =
  /^steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\.outputs\.([A-Za-z][A-Za-z0-9_]*)$/u;

/** Parse a reference, or undefined when it has neither form. */
export const parseReference = (ref: string): Reference | undefined => {
  const context = CONTEXT.exec(ref);
  if (context !== null) return { kind: "context", field: context[1]! };
  const output = OUTPUT.exec(ref);
  if (output !== null)
    return { kind: "output", step: output[1]!, output: output[2]! };
  return undefined;
};

/** The reference string for an earlier step's output. */
export const outputReference = (step: string, output: string) =>
  `steps.${step}.outputs.${output}`;
