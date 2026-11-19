import { Result, Schema, SchemaIssue } from "effect";

import type { WorkflowSpec } from "$/workflows/contracts";
import { parseReference } from "$/workflows/references";
import {
  type Contract,
  runContextFields,
  type StepTypes,
} from "$/workflows/registry";

/** One reason a specification cannot be saved, at a path into its JSON. */
export interface WorkflowIssue {
  readonly path: readonly string[];
  readonly message: string;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** Every schema issue of decoding `value`, prefixed with `path`. */
const schemaIssues = (
  schema: Schema.Codec<unknown, unknown>,
  value: unknown,
  path: readonly string[],
): WorkflowIssue[] => {
  const result = Schema.decodeUnknownResult(schema, {
    errors: "all",
    onExcessProperty: "error",
  })(value);
  if (Result.isSuccess(result)) return [];
  return formatIssue(result.failure.issue).issues.map((issue) => ({
    path: [...path, ...(issue.path ?? []).map(String)],
    message: issue.message,
  }));
};

const isContextField = (
  field: string,
): field is keyof typeof runContextFields =>
  Object.hasOwn(runContextFields, field);

/**
 * Check a decoded specification against the step registry before it is
 * saved: unique step IDs, known step types usable in the definition's scope,
 * parameters matching each type's schema, exactly the declared inputs, and
 * bindings whose literal values or referenced contracts match each input's
 * contract. References must name a run-context field or an output of an
 * earlier step, so no self, forward or missing references (and therefore no
 * cycles) can be saved. Returns every issue found; empty means valid.
 */
export const validateWorkflowSpec = (
  spec: WorkflowSpec,
  registry: StepTypes,
): readonly WorkflowIssue[] => {
  const issues: WorkflowIssue[] = [];
  const allIds = new Set(spec.steps.map((step) => step.id));
  /** Earlier steps by ID: the first occurrence wins. */
  const earlier = new Map<string, { readonly position: number }>();

  spec.steps.forEach((step, index) => {
    const at = (...path: string[]) => ["steps", String(index), ...path];
    const issue = (path: string[], message: string) =>
      issues.push({ path, message });

    const previous = earlier.get(step.id);
    if (previous !== undefined)
      issue(
        at("id"),
        `Step ID "${step.id}" is already used by step ${previous.position}`,
      );

    const stepType = registry.get(step.type);
    if (stepType === undefined) {
      issue(at("type"), `Unknown step type "${step.type}"`);
    } else {
      if (!stepType.scopes.includes(spec.scope))
        issue(
          at("type"),
          `Step type "${step.type}" cannot be used in ${spec.scope} workflows (it supports: ${stepType.scopes.join(", ")})`,
        );
      issues.push(...schemaIssues(stepType.params, step.params, at("params")));
      for (const name of Object.keys(step.inputs))
        if (!Object.hasOwn(stepType.inputs, name))
          issue(
            at("inputs", name),
            `Step type "${step.type}" has no input "${name}"`,
          );
      for (const name of Object.keys(stepType.inputs))
        if (!Object.hasOwn(step.inputs, name))
          issue(at("inputs"), `Missing binding for input "${name}"`);
    }

    for (const [name, binding] of Object.entries(step.inputs)) {
      const path = at("inputs", name);
      const port =
        stepType !== undefined && Object.hasOwn(stepType.inputs, name)
          ? stepType.inputs[name]
          : undefined;

      if ("value" in binding) {
        if (port !== undefined)
          issues.push(
            ...schemaIssues(port.contract.schema, binding.value, [
              ...path,
              "value",
            ]).map((found) => ({
              ...found,
              message: `Literal for contract "${port.contract.id}": ${found.message}`,
            })),
          );
        continue;
      }

      const refPath = [...path, "ref"];
      const reference = parseReference(binding.ref);
      let provided: Contract<any> | undefined;
      if (reference === undefined) {
        issue(
          refPath,
          `Invalid reference "${binding.ref}": expected context.<field> or steps.<id>.outputs.<name>`,
        );
      } else if (reference.kind === "context") {
        if (isContextField(reference.field))
          provided = runContextFields[reference.field].contract(spec.scope);
        else
          issue(
            refPath,
            `Unknown run-context field "${reference.field}" (available: ${Object.keys(runContextFields).join(", ")})`,
          );
      } else if (reference.step === step.id && previous === undefined) {
        issue(
          refPath,
          `"${binding.ref}" refers to this step's own output; use an earlier step's output`,
        );
      } else if (!earlier.has(reference.step)) {
        issue(
          refPath,
          allIds.has(reference.step)
            ? `"${binding.ref}" refers to a later step; steps can only use outputs of earlier steps`
            : `"${binding.ref}" refers to an unknown step "${reference.step}"`,
        );
      } else {
        const source = spec.steps.find((s) => s.id === reference.step)!;
        const sourceType = registry.get(source.type);
        // An unknown source type is reported on that step already.
        if (sourceType !== undefined) {
          provided = Object.hasOwn(sourceType.outputs, reference.output)
            ? sourceType.outputs[reference.output]!.contract
            : undefined;
          if (provided === undefined)
            issue(
              refPath,
              `Step "${reference.step}" (${source.type}) has no output "${reference.output}"`,
            );
        }
      }

      if (
        port !== undefined &&
        provided !== undefined &&
        provided.id !== port.contract.id
      )
        issue(
          refPath,
          `Input "${name}" expects contract "${port.contract.id}" but "${binding.ref}" provides "${provided.id}"`,
        );
    }

    if (previous === undefined) earlier.set(step.id, { position: index + 1 });
  });

  return issues;
};
