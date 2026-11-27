import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import type * as Workflows from "$/workflows/contracts";
import type * as Runs from "$/workflows/runs/contracts";
import type * as RunViews from "$/workflows/runs/views";
import type * as WorkflowViews from "$/workflows/views";

type DomainRecords = readonly [
  Workflows.Subject,
  Workflows.Binding,
  Workflows.StepSpec,
  Workflows.WorkflowDefinition,
  Workflows.WorkflowSummary,
  Workflows.WorkflowAssignment,
  Workflows.WorkflowDefault,
  Runs.WorkflowRunStatus,
  Runs.ActiveRunStatus,
  Runs.StepOutcomeStatus,
  Runs.RunTrigger,
  Runs.WorkflowRunSummary,
  Runs.MissingDependency,
  Runs.DependencyWait,
  Runs.StepOutcome,
  Runs.WorkflowRunDetail,
];

type ViewRecords = readonly [
  WorkflowViews.SubjectView,
  WorkflowViews.BindingView,
  WorkflowViews.StepSpecView,
  WorkflowViews.WorkflowDefinition,
  WorkflowViews.WorkflowSummary,
  WorkflowViews.WorkflowAssignment,
  WorkflowViews.WorkflowDefault,
  RunViews.WorkflowRunStatus,
  RunViews.ActiveRunStatus,
  RunViews.StepOutcomeStatus,
  RunViews.RunTrigger,
  RunViews.WorkflowRunSummary,
  RunViews.MissingDependency,
  RunViews.DependencyWaitView,
  RunViews.StepOutcome,
  RunViews.WorkflowRunDetail,
];

test("workflow domain records retain their browser DTO shapes", () => {
  const compatible: [DomainRecords, ViewRecords] extends [
    ViewRecords,
    DomainRecords,
  ]
    ? true
    : false = true;
  assert.ok(compatible);
});

test("workflow contracts and persistence do not depend on views", () => {
  for (const path of [
    "contracts.ts",
    "store.ts",
    "d1.ts",
    "runs/contracts.ts",
    "runs/store.ts",
    "runs/d1.ts",
  ]) {
    const source = readFileSync(
      new URL(`../src/workflows/${path}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:\bfrom\s*|\bimport\s*\()\s*["'][^"']*\bviews(?:\.[cm]?tsx?)?["']/u,
      path,
    );
  }
});

test("workflow views stay runtime-free and only depend on views or subject kinds", () => {
  for (const path of ["views.ts", "runs/views.ts"]) {
    const source = readFileSync(
      new URL(`../src/workflows/${path}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /^\s*import(?!\s+type\b)/mu, path);
    assert.doesNotMatch(
      source,
      /^\s*export\s+(?:const|let|var|class|function|enum)\b/mu,
      path,
    );
    for (const dependency of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/gu,
    )) {
      assert.match(
        dependency[1]!,
        /^\.\.?\/(?:[^/]+\/)*(?:views|subjects)$/u,
        path,
      );
    }
  }
});

test("the subject kinds module has no imports, so views and the app can share it", () => {
  const source = readFileSync(
    new URL("../src/workflows/subjects.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /(?:\bfrom\s*|\bimport\s*\()\s*["']/u);
});
