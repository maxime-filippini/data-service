---
title: Scheduling
description: How cron expressions, slots and the hourly tick start calculation runs.
---

Each calculation has a standard 5-field cron expression in **UTC**. There is no
separate scheduler: the Worker's existing hourly cron checks every calculation.

## Cron slots

A **slot** is a whole UTC hour the expression fires in. Because the tick runs
hourly, the **minute field has no effect** and the finest resolution is one
hour. Monthly calculations are just a cron expression.

On each tick, after the download trigger and the stuck-run check:

```mermaid
flowchart TD
  tick([Hourly tick]) --> each{{For each enabled calculation}}
  each --> slot["Most recent slot ≤ now<br/>from its cron expression"]
  slot --> due{"slot &gt; last_scheduled_slot<br/>and slot &gt; created_at?"}
  due -- no --> skip([Nothing to do])
  due -- yes --> claim["Claim the slot<br/>conditional UPDATE last_scheduled_slot"]
  claim --> won{Claim won?}
  won -- no, another tick got it --> skip
  won -- yes --> start["Start a run as of<br/>the previous UTC day"]
  start --> ok{Started?}
  ok -- yes --> done([Run going])
  ok -- no --> fail(["Recorded as failed<br/>slot not retried"])
```

- **Missed slots run once.** Each calculation stores the last slot it ran for
  (`last_scheduled_slot`). If the tick missed several slots, only the most
  recent one runs; missed slots are not replayed.
- **At most once per slot.** The tick claims a slot with a conditional update
  before starting the run, so a slot runs at most once even if the tick fires
  twice.
- **New and paused calculations.** A new calculation doesn't run for slots
  before its creation. A paused calculation catches up its latest slot once
  when it's enabled again.

## Example

A calculation with cron `0 8 * * 1-5` (08:00 UTC on weekdays), created on a
Monday at 10:00:

```mermaid
timeline
  title Hourly ticks for cron 0 8 on weekdays
  Mon 10h : Calculation created : Mon 08h slot is before creation, so nothing runs
  Tue 08h : Slot Tue 08h claimed : Run as of Mon
  Tue 09h : Most recent slot already claimed, nothing runs
  Wed 08h : Tick missed (outage)
  Wed 09h : Slot Wed 08h claimed late : Run as of Tue
```

## The as-of date

A scheduled run calculates as of the **previous UTC day**, using whatever
canonical data exists when it starts. It doesn't wait for that day's
downloads, so **schedule calculations a few hours after the download hour**.

```mermaid
gantt
  dateFormat HH:mm
  axisFormat %H:%M
  title A good daily layout (UTC)
  section Market data
  Daily download run starts (hour 06) :milestone, 06:00, 0m
  Downloads + Parquet rebuilds :active, 06:00, 90m
  section Calculations
  Calculation slot (0 9 * * *) :milestone, 09:00, 0m
  Run as of yesterday :09:00, 30m
```

To fill in a past date, use run now with an `asOf`:

```sh
curl -X POST "$URL/api/calculations/$ID/runs" -H "Authorization: Bearer $MANAGEMENT_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"asOf":"2026-10-16"}'
```
