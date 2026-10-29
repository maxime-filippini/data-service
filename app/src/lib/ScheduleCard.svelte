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
    schedule: initialSchedule,
    runs: initialRuns,
    scheduledCount,
    onnotify,
  }: {
    /** As loaded with the page; the card reloads them after each change. */
    schedule: ScheduleView;
    runs: readonly ScheduleRun[];
    scheduledCount: number;
    /** Show an outcome in the page's message area. */
    onnotify: (outcome: { message: string } | { error: string } | null) => void;
  } = $props();

  let schedule = $derived<ScheduleView | null>(initialSchedule);
  let runs = $derived<readonly ScheduleRun[]>(initialRuns);
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
    <table class="stack">
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
            <td data-label="Started" title={run.runId}>{formatDateTime(run.createdAt)}</td>
            <td data-label="Trigger">{run.trigger === "manual" ? "Manual" : "Schedule"}</td>
            <td data-label="Status"><StatusBadge status={run.status} /></td>
            <td data-label="Data through" class="mono">{run.snapshotTo}</td>
            <td data-label="Queued" class="num">
              {run.queuedCount === null ? "—" : formatCount(run.queuedCount)}
            </td>
            <td class="bad full" class:wide-only={!run.error}>{run.error ?? ""}</td>
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
    white-space: nowrap;
  }
  .bad {
    color: var(--bad-fg);
  }
  button.link {
    all: unset;
    cursor: pointer;
    color: var(--accent);
  }
  button.link:hover {
    background: none;
    text-decoration: underline;
  }
  table {
    border-top: 1px solid var(--border);
  }

  /* Phones: the hour picker gets its own row, with the buttons below. */
  @media (max-width: 720px) {
    .controls {
      flex: 1 1 100%;
      flex-wrap: wrap;
    }
    .controls label {
      flex: 1 1 100%;
    }
    .controls select {
      flex: 1;
      min-width: 0;
    }
    .controls button {
      flex: 1;
    }
    button.link {
      padding: 0.4rem 0;
    }
  }
</style>
