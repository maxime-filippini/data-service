import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Logger, References } from "effect";
import { TestConsole } from "effect/testing";

import { WorkerLoggerLive } from "$/logging";
import type { TickReport } from "$/workflows/runs/dispatch";
import { reportDispatch } from "$/workflows/runs/report";

const report: TickReport = {
  status: "dispatched",
  reconciled: { kept: 3, failed: 2 },
  runs: [
    {
      runId: "run-1",
      workflowId: "workflow-1",
      subject: { kind: "asset", symbol: "AAPL.US" },
      scheduledFor: "2024-01-10T06:00:00.000Z",
      processingDate: "2024-01-10",
      status: "queued",
    },
  ],
  failures: [
    {
      workflowId: "workflow-2",
      subject: { kind: "asset", symbol: "MSFT.US" },
      scheduledFor: "2024-01-10T06:00:00.000Z",
      error: "Assignment disabled",
    },
  ],
};

test("dispatch reports use structured Effect logs and preserve their summary", async () => {
  const captured = await Effect.gen(function* () {
    const summary = yield* reportDispatch(report).pipe(
      Effect.provide(WorkerLoggerLive),
    );
    return {
      summary,
      logs: yield* TestConsole.logLines,
      errors: yield* TestConsole.errorLines,
    };
  }).pipe(Effect.provide(TestConsole.layer), Effect.runPromise);

  assert.deepEqual(captured.summary, {
    status: "dispatched",
    reconciled: { kept: 3, failed: 2 },
    dispatched: 1,
    failed: 1,
  });
  const logs = captured.logs.map((line) => JSON.parse(String(line)));
  const errors = captured.errors.map((line) => JSON.parse(String(line)));
  assert.equal(logs.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(logs[0].level, "INFO");
  assert.equal(logs[0].message, "workflow_dispatched");
  assert.deepEqual(logs[0].annotations, report.runs[0]);
  assert.equal(logs[1].message, "workflow_runs_failed_as_stopped");
  assert.deepEqual(logs[1].annotations, { count: 2 });
  assert.equal(errors[0].level, "ERROR");
  assert.equal(errors[0].message, "workflow_dispatch_failed");
  assert.deepEqual(errors[0].annotations, report.failures[0]);
});

test("dispatch reporting honors an injected Effect logger", async () => {
  const messages: unknown[] = [];
  const logger = Logger.make((options) => messages.push(options.message));
  await reportDispatch(report).pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.runPromise,
  );
  assert.deepEqual(messages, [
    ["workflow_dispatched"],
    ["workflow_dispatch_failed"],
    ["workflow_runs_failed_as_stopped"],
  ]);
});

test("dispatch logs inherit annotations and respect Effect's minimum level", async () => {
  const captured = await Effect.gen(function* () {
    yield* reportDispatch(report).pipe(
      Effect.annotateLogs({ dispatchId: "dispatch-2024-01-10-06" }),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    );
    return {
      logs: yield* TestConsole.logLines,
      errors: yield* TestConsole.errorLines,
    };
  }).pipe(
    Effect.provide(WorkerLoggerLive),
    Effect.provide(TestConsole.layer),
    Effect.runPromise,
  );
  assert.deepEqual(captured.logs, []);
  assert.equal(captured.errors.length, 1);
  const failure = JSON.parse(String(captured.errors[0]));
  assert.equal(failure.message, "workflow_dispatch_failed");
  assert.deepEqual(failure.annotations, {
    dispatchId: "dispatch-2024-01-10-06",
    ...report.failures[0],
  });
});

test("disabled and empty dispatch reports produce no logs", async () => {
  const captured = await Effect.gen(function* () {
    const disabled = yield* reportDispatch({ status: "disabled" });
    const empty = yield* reportDispatch({
      status: "dispatched",
      reconciled: { kept: 1, failed: 0 },
      runs: [],
      failures: [],
    });
    return {
      disabled,
      empty,
      logs: yield* TestConsole.logLines,
      errors: yield* TestConsole.errorLines,
    };
  }).pipe(
    Effect.provide(WorkerLoggerLive),
    Effect.provide(TestConsole.layer),
    Effect.runPromise,
  );
  assert.deepEqual(captured.disabled, { status: "disabled" });
  assert.deepEqual(captured.empty, {
    status: "dispatched",
    reconciled: { kept: 1, failed: 0 },
    dispatched: 0,
    failed: 0,
  });
  assert.deepEqual(captured.logs, []);
  assert.deepEqual(captured.errors, []);
});
