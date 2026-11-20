import type { WorkflowDefinition } from "$/workflows/contracts";
import { parseReference } from "$/workflows/references";
import type { StepTypeRegistry } from "$/workflows/registry";
import type {
  InputSource,
  StepDetail,
  WorkflowDetail,
} from "$/workflows/views";

/**
 * Build a saved definition's detail for reading. The definition stores only
 * what was submitted; the detail adds what the current step registry knows:
 * its steps in execution order, each input's contract and source (literal,
 * run context or an earlier step's output), and each output's later
 * consumers. A step type removed since saving shows without description or
 * contracts.
 */
export const buildWorkflowDetail = (
  workflow: WorkflowDefinition,
  registry: StepTypeRegistry,
): WorkflowDetail => {
  /** Later inputs using each `step/output`. */
  const usedBy = new Map<string, { step: string; input: string }[]>();
  const sources = workflow.steps.map((step) =>
    Object.entries(step.inputs).map(
      ([name, binding]): [string, InputSource] => {
        if ("value" in binding)
          return [name, { kind: "literal", value: binding.value }];
        const reference = parseReference(binding.ref);
        if (reference?.kind === "output") {
          const key = `${reference.step}/${reference.output}`;
          usedBy.set(key, [
            ...(usedBy.get(key) ?? []),
            { step: step.id, input: name },
          ]);
          return [
            name,
            {
              kind: "output",
              ref: binding.ref,
              step: reference.step,
              output: reference.output,
            },
          ];
        }
        return [
          name,
          {
            kind: "context",
            ref: binding.ref,
            field: reference?.field ?? binding.ref,
          },
        ];
      },
    ),
  );

  const steps = workflow.steps.map((step, index): StepDetail => {
    const stepType = registry.get(step.type);
    return {
      position: index + 1,
      id: step.id,
      type: step.type,
      description: stepType?.description ?? null,
      params: step.params,
      inputs: sources[index]!.map(([name, source]) => ({
        name,
        contract:
          stepType !== undefined && Object.hasOwn(stepType.inputs, name)
            ? stepType.inputs[name]!.contract.id
            : null,
        source,
      })),
      outputs: Object.entries(stepType?.outputs ?? {}).map(([name, port]) => ({
        name,
        contract: port.contract.id,
        description: port.description,
        usedBy: usedBy.get(`${step.id}/${name}`) ?? [],
      })),
    };
  });

  return { workflow, steps };
};
