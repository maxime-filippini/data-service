import type { Subject } from "$/workflows/contracts";

/**
 * The current publication of one dataset for one subject. Names its
 * producer (the workflow, run and step that published it) and processing
 * date, but no storage location: the data is retrieved by dataset and
 * subject. The workflow name is the one the run captured, so it survives
 * the definition's deletion.
 */
export interface PublicationView {
  readonly dataset: string;
  readonly subject: Subject;
  readonly processingDate: string;
  readonly producer: {
    readonly workflowId: string;
    readonly workflowName: string | null;
    readonly runId: string;
    readonly stepId: string;
  };
  readonly format: string;
  readonly schema: string;
  /** The published object's size in bytes and ETag. */
  readonly size: number;
  readonly etag: string;
  readonly publishedAt: string;
}
