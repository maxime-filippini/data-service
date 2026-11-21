import {
  type SubjectKind,
  type SubjectView,
  subjectId,
} from "../../../src/workflows/subjects";
import { href, type View } from "./router.svelte";

export type { SubjectKind } from "../../../src/workflows/subjects";
export {
  isSubjectKind,
  SUBJECT_KINDS,
  subjectId,
  subjectOf,
} from "../../../src/workflows/subjects";

/** Each subject kind's name, as a heading or link label. */
export const subjectKindLabels = {
  asset: "Asset",
  portfolio: "Portfolio",
} as const satisfies Record<SubjectKind, string>;

/** The list page of each subject kind; a subject's page is under it. */
const subjectViews = {
  asset: "assets",
  portfolio: "portfolios",
} as const satisfies Record<SubjectKind, View>;

/** The page of a workflow subject. */
export const subjectHref = (subject: SubjectView) =>
  href(subjectViews[subject.kind], { id: subjectId(subject) });

/** "AAPL.US" for an asset, the ID for a portfolio. */
export const subjectLabel = subjectId;

/** "02:00 UTC" */
export const formatHourUtc = (hour: number) =>
  `${String(hour).padStart(2, "0")}:00 UTC`;
