import assert from "node:assert/strict";
import test from "node:test";

import {
  addUtcDays,
  atUtcHour,
  nextUtcHour,
  previousDay,
  startOfUtcDay,
  utcDay,
} from "$/datetime";

test("data cutoffs follow UTC dates across leap days and offset inputs", () => {
  const now = new Date("2024-03-01T00:30:00+02:00");
  assert.equal(utcDay(now), "2024-02-29");
  assert.equal(previousDay(now), "2024-02-28");
  assert.equal(previousDay(new Date("2024-03-01T00:00:00Z")), "2024-02-29");
  assert.equal(previousDay(new Date("2025-01-01T00:00:00Z")), "2024-12-31");
});

test("UTC scheduling crosses year and daylight-saving changes without mutating input", () => {
  const now = new Date("2026-12-31T23:45:12.345Z");
  const original = now.toISOString();
  assert.equal(startOfUtcDay(now).toISOString(), "2026-12-31T00:00:00.000Z");
  assert.equal(atUtcHour(now, 6).toISOString(), "2026-12-31T06:00:00.000Z");
  assert.equal(nextUtcHour(now).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(
    atUtcHour(addUtcDays(now, 1), 6).toISOString(),
    "2027-01-01T06:00:00.000Z",
  );
  assert.equal(now.toISOString(), original);

  const beforeDst = new Date("2026-03-28T12:00:00Z");
  assert.equal(
    addUtcDays(beforeDst, 1).toISOString(),
    "2026-03-29T12:00:00.000Z",
  );
});

test("hourly ticks are strictly later and UTC rounding works before the epoch", () => {
  assert.equal(
    nextUtcHour(new Date("2026-11-09T06:00:00Z")).toISOString(),
    "2026-11-09T07:00:00.000Z",
  );
  const beforeEpoch = new Date("1969-12-31T23:59:59.999Z");
  assert.equal(
    startOfUtcDay(beforeEpoch).toISOString(),
    "1969-12-31T00:00:00.000Z",
  );
  assert.equal(
    nextUtcHour(beforeEpoch).toISOString(),
    "1970-01-01T00:00:00.000Z",
  );
});
