// The kinds of subject a workflow runs for, and how each kind is identified.
// The Worker and the app both use this list. This file has no imports, so the
// app can import its values directly.

/**
 * Every subject kind, which is also every definition scope. To add a kind:
 * add it here, handle it in the switches and records the compiler then
 * reports, and write a migration that widens the `CHECK` constraints on
 * `workflow_definitions.scope` and `workflow_assignments.subject_kind`.
 */
export const SUBJECT_KINDS = ["asset", "portfolio"] as const;

export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Whether a string, such as a URL parameter, names a subject kind. */
export const isSubjectKind = (value: string): value is SubjectKind =>
  (SUBJECT_KINDS as readonly string[]).includes(value);

/** The asset or portfolio a workflow runs for. */
export type SubjectView =
  | { readonly kind: "asset"; readonly symbol: string }
  | { readonly kind: "portfolio"; readonly id: string };

/** A subject's identifier: an asset's symbol or a portfolio's ID. */
export const subjectId = (subject: SubjectView): string => {
  switch (subject.kind) {
    case "asset":
      return subject.symbol;
    case "portfolio":
      return subject.id;
  }
};

/** The subject of a kind with an identifier, as stored in assignments. */
export const subjectOf = (kind: SubjectKind, id: string): SubjectView => {
  switch (kind) {
    case "asset":
      return { kind, symbol: id };
    case "portfolio":
      return { kind, id };
  }
};
