import type { SubjectView } from "./api";
import { href } from "./router.svelte";

/** The page of a workflow subject: an asset or a portfolio. */
export const subjectHref = (subject: SubjectView) =>
  subject.kind === "asset"
    ? href("assets", { id: subject.symbol })
    : href("portfolios", { id: subject.id });

/** "AAPL.US" for an asset, the ID for a portfolio. */
export const subjectLabel = (subject: SubjectView) =>
  subject.kind === "asset" ? subject.symbol : subject.id;

/** "02:00 UTC" */
export const formatHourUtc = (hour: number) =>
  `${String(hour).padStart(2, "0")}:00 UTC`;
