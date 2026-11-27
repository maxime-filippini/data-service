import { Effect, Schema } from "effect";

import {
  PUBLISHED_DATASETS,
  PublishedDatasetSchema,
} from "$/datasets/contracts";
import { publishDataset as publish } from "$/datasets/operations";
import { SUBJECT_KINDS } from "$/workflows/subjects";

import {
  datasetPublicationContract,
  publishableDatasetContract,
} from "./contract";
import { defineStepType, terminal, transient } from "./step-type";

/**
 * Publish a run's dataset artifact as the run subject's current dataset.
 * The data is copied to the dataset's stable location (for prices_eod the
 * location existing consumers read), so it does not depend on the expiring
 * run artifact, and the publication's producer and processing date are
 * recorded after the copy succeeds. The subject and processing date are the
 * run's own, never inputs, so a definition cannot publish another subject's
 * dataset. A run whose earlier steps fail never reaches this step, leaving
 * the previous publication intact.
 */
export const publishDataset = defineStepType({
  type: "publish-dataset",
  description:
    "Publish a dataset artifact as the subject's current dataset, independently of temporary run storage",
  scopes: SUBJECT_KINDS,
  params: Schema.Struct({
    dataset: PublishedDatasetSchema.annotate({
      description:
        "The dataset to publish, e.g. prices_eod or portfolio_volatility",
    }),
  }),
  inputs: {
    data: {
      contract: publishableDatasetContract,
      description:
        "The dataset's data, from the normalization or volatility step",
    },
  },
  outputs: {
    publication: {
      contract: datasetPublicationContract,
      description: "The published dataset's identity",
    },
  },
  validateConfiguration: ({ dataset }, scope, inputs) => {
    const expected = PUBLISHED_DATASETS[dataset];
    if (scope !== expected.subjectKind)
      return [
        {
          path: ["params", "dataset"],
          message: `${dataset} can only be published for a subject of kind ${expected.subjectKind}`,
        },
      ];
    const data = inputs.data;
    if (
      data !== undefined &&
      "value" in data &&
      Schema.is(publishableDatasetContract.schema)(data.value) &&
      data.value.schema !== expected.schema
    )
      return [
        {
          path: ["inputs", "data", "value"],
          message: `${dataset} must be published from ${expected.schema} data`,
        },
      ];
    return [];
  },
  implementation: ({ params, inputs, context, execution }) =>
    Effect.gen(function* () {
      const expected = PUBLISHED_DATASETS[params.dataset];
      if (context.subject.kind !== expected.subjectKind)
        return yield* terminal(
          `${params.dataset} can only be published for a subject of kind ${expected.subjectKind}`,
        );
      if (inputs.data.schema !== expected.schema)
        return yield* terminal(
          `${params.dataset} must be published from ${expected.schema} data, not ${inputs.data.schema}`,
        );
      yield* publish({
        dataset: params.dataset,
        subject: context.subject,
        processingDate: context.processingDate,
        artifact: inputs.data,
        producer: execution,
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "DatasetError"
            ? error.kind === "not_found"
              ? terminal(error.message)
              : transient(error.message)
            : error.kind === "storage"
              ? transient(error.message)
              : terminal(error.message),
        ),
      );
      return {
        publication: {
          dataset: params.dataset,
          subject: context.subject,
          processingDate: context.processingDate,
        },
      };
    }),
});
