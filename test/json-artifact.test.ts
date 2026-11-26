import assert from "node:assert/strict";
import test from "node:test";

import { Cause, Effect, Exit, Fiber, Result, Schema } from "effect";

import { RunArtifacts } from "$/workflows/artifacts";
import { readJsonArtifact } from "$/workflows/registry/json-artifact";

const reference = {
  id: "runs/11111111-1111-4111-8111-111111111111/holdings/holdings.json",
  format: "json",
  schema: "test-message/v1",
} as const;

const read = (body: ReadableStream<Uint8Array>) =>
  readJsonArtifact(reference, Schema.Struct({ message: Schema.String })).pipe(
    Effect.provideService(RunArtifacts, {
      get: () => Effect.succeed({ body, contentType: "application/json" }),
      put: () => Effect.void,
    }),
  );

test(
  "interrupting an artifact read cancels the pending stream and releases its lock",
  { timeout: 5_000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        start: (stream) => {
          controller = stream;
        },
        pull: () => {
          started.resolve();
        },
        cancel: () => {
          cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );
    // Also let an uninterruptible implementation finish if this regression fails.
    t.after(() => {
      if (body.locked) controller.close();
    });
    const fiber = Effect.runFork(read(body));
    await started.promise;
    assert.equal(body.locked, true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    assert.ok(Exit.isFailure(exit));
    assert.ok(Cause.hasInterruptsOnly(exit.cause));
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  },
);

for (const rejectsCancellation of [false, true]) {
  test(`an oversized artifact stays terminal and releases its reader when cancellation ${rejectsCancellation ? "rejects" : "succeeds"}`, async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        },
        cancel: () => {
          cancelled += 1;
          return rejectsCancellation
            ? Promise.reject(new Error("cancel failed"))
            : undefined;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await Effect.runPromise(read(body).pipe(Effect.result));
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure.retry, false);
    assert.match(result.failure.message, /JSON artifact exceeds/u);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  });
}

test("a failed stream read remains retryable and releases its lock", async () => {
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        controller.error(new Error("connection lost"));
      },
    },
    { highWaterMark: 0 },
  );
  const result = await Effect.runPromise(read(body).pipe(Effect.result));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.retry, true);
  assert.equal(result.failure.message, "Could not read the JSON run artifact");
  assert.equal(body.locked, false);
});

test("artifact reading decodes UTF-8 across chunks and releases the completed stream", async () => {
  const value = { message: "€🦊" };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let position = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        if (position === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(position, ++position));
      },
      cancel: () => {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(await Effect.runPromise(read(body)), value);
  assert.equal(body.locked, false);
  assert.equal(cancelled, false);
});
