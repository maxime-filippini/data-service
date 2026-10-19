<script lang="ts">
  import {
    fetchSchedule,
    fetchScheduleRuns,
    runScheduleNow,
    type ScheduleRun,
    type ScheduleView,
    updateSchedule,
  } from "./api";
  import { formatAgo, formatCount, formatDateTime } from "./format";
  import StatusBadge from "./StatusBadge.svelte";

  let {
    scheduledCount,
    onnotify,
  }: {
    scheduledCount: number;
    /** Show an outcome in the page's message area. */
    onnotify: (outcome: { message: string } | { error: string } | null) => void;
  } = $props();

  let schedule = $state<ScheduleView | null>(null);
  let runs = $state<ScheduleRun[]>([]);
  let busy = $state(false);
  let showHistory = $state(false);

  const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
  const localTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

  /** "06:00 UTC (08:00 local)" */
  const hourLabel = (hour: number) => {
    const utc = `${String(hour).padStart(2, "0")}:00 UTC`;
    const date = new Date();
    date.setUTCHours(hour, 0, 0, 0);
    return date.getTimezoneOffset() === 0 ? utc : `${utc} (${localTime.format(date)} local)`;
  };

  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  const load = async () => {
    try {
      const [view, history] = await Promise.all([fetchSchedule(), fetchScheduleRuns(10)]);
      schedule = view;
      runs = history.runs;
    } catch (cause) {
      onnotify({ error: describe(cause) });
    }
  };
  void load();

  const act = async (action: () => Promise<string>) => {
    busy = true;
    onnotify(null);
    try {
      onnotify({ message: await action() });
      await load();
    } catch (cause) {
      onnotify({ error: describe(cause) });
    } finally {
      busy = false;
    }
  };

  const setHour = (hourUtc: number) =>
    act(async () => {
      schedule = await updateSchedule({ hourUtc });
      return `Daily download moved to ${hourLabel(hourUtc)}.`;
    });

  const togglePaused = () =>
    act(async () => {
      const paused = !schedule?.paused;
      schedule = await updateSchedule({ paused });
      return paused ? "Daily download paused." : "Daily download resumed.";
    });

  const runNow = () => {
    const count = `${scheduledCount} symbol${scheduledCount === 1 ? "" : "s"}`;
    if (!window.confirm(`Download the full history of all ${count} on the schedule now?`)) return;
    void act(async () => {
      await runScheduleNow();
      return `Started a run for ${count}. Downloads show up under Ingestion runs.`;
    });
  };

  const latest = $derived(runs[0]);
</script>

<section class="card schedule">
  <div class="row">
    <div class="summary">
      <strong>Daily download</strong>
      {#if schedule}
        <span class="state" class:paused={schedule.paused}>{schedule.paused ? "Paused" : "Active"}</span>
        <span class="muted">
          {#if schedule.paused}
            No downloads run until you resume.
          {:else if schedule.nextRunAt}
            Next run {formatAgo(schedule.nextRunAt)}
            <span title={schedule.nextRunAt}>({formatDateTime(schedule.nextRunAt)})</span>
          {/if}
          · {scheduledCount} symbol{scheduledCount === 1 ? "" : "s"} on the schedule
        </span>
      {:else}
        <span class="muted">Loading…</span>
      {/if}
    </div>
    {#if schedule}
      <div class="controls">
        <label class="muted">
          Runs after
          <select
            aria-label="Daily download hour"
            value={schedule.hourUtc}
            disabled={busy}
            onchange={(event) => setHour(Number(event.currentTarget.value))}
          >
            {#each HOURS as hour (hour)}
              <option value={hour}>{hourLabel(hour)}</option>
            {/each}
          </select>
        </label>
        <button onclick={togglePaused} disabled={busy}>{schedule.paused ? "Resume" : "Pause"}</button>
        <button class="primary" onclick={runNow} disabled={busy || scheduledCount === 0}>Run now</button>
      </div>
    {/if}
  </div>

  {#if latest}
    <div class="row last muted">
      <span>
        Last run:
        <StatusBadge status={latest.status} title={latest.error ?? undefined} />
        {latest.trigger === "manual" ? "manual" : "scheduled"},
        <span title={formatDateTime(latest.createdAt)}>{formatAgo(latest.createdAt)}</span>
        {#if latest.queuedCount !== null}· {formatCount(latest.queuedCount)} queued{/if}
        {#if latest.skippedCount}· {formatCount(latest.skippedCount)} not started yet{/if}
        {#if latest.error}· <span class="bad">{latest.error}</span>{/if}
      </span>
      <button class="link" onclick={() => (showHistory = !showHistory)}>
        {showHistory ? "Hide history" : "History"}
      </button>
    </div>
  {/if}

  {#if showHistory}
    <table>
      <thead>
        <tr>
          <th>Started</th>
          <th>Trigger</th>
          <th>Status</th>
          <th>Data through</th>
          <th class="num">Queued</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.runId)}
          <tr>
            <td title={run.runId}>{formatDateTime(run.createdAt)}</td>
            <td>{run.trigger === "manual" ? "Manual" : "Schedule"}</td>
            <td><StatusBadge status={run.status} /></td>
            <td class="mono">{run.snapshotTo}</td>
            <td class="num">{run.queuedCount === null ? "—" : formatCount(run.queuedCount)}</td>
            <td class="bad">{run.error ?? ""}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .schedule {
    margin-bottom: 1rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
  }
  .row.last {
    border-top: 1px solid var(--border);
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
    font-size: 0.9rem;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.6rem;
  }
  .state {
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--ok-bg);
    color: var(--ok-fg);
  }
  .state.paused {
    background: var(--neutral-bg);
    color: var(--neutral-fg);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .controls label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .bad {
    color: var(--bad-fg);
  }
  button.link {
    all: unset;
    cursor: pointer;
    color: var(--accent);
  }
  table {
    border-top: 1px solid var(--border);
  }
</style>
