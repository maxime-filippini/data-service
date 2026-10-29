<script lang="ts">
  import { refreshAll } from "$app/navigation";
  import { navigating } from "$app/state";

  import { runScheduleNow } from "#lib/api.ts";
  import { formatAgo, formatCount, formatDateTime } from "#lib/format.ts";
  import { href } from "#lib/router.svelte.ts";
  import StatusBadge from "#lib/StatusBadge.svelte";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const home = $derived(data.home);
  const symbols = $derived(home.symbols);
  const latestScheduleRun = $derived(home.scheduleRuns[0]);

  let busy = $state(false);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);

  const hour = (hourUtc: number) => `${String(hourUtc).padStart(2, "0")}:00 UTC`;

  const runNow = async () => {
    const count = `${symbols.scheduled} symbol${symbols.scheduled === 1 ? "" : "s"}`;
    if (!confirm(`Download the full history of all ${count} on the schedule now?`)) return;
    busy = true;
    error = null;
    message = null;
    try {
      await runScheduleNow();
      message = `Started a run for ${count}. Downloads show up under Ingestion runs.`;
      await refreshAll();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  };

  const SECTIONS = [
    { path: "/runs", title: "Ingestion runs", text: "Every download, with its Parquet rebuild." },
    { path: "/symbols", title: "Symbols", text: "The universe, and the daily download schedule." },
    { path: "/portfolios", title: "Portfolios", text: "Holdings snapshots that calculations run over." },
    { path: "/calculations", title: "Calculations", text: "Saved calculations, their crons and runs." },
    { path: "/explore", title: "Explore data", text: "Browse any symbol's or calculation's Parquet file." },
  ];
</script>

<section class="intro">
  <h1>Data service</h1>
  <p class="muted">
    Downloads market data for a universe of symbols every day, builds one Parquet file per symbol in R2, and runs
    calculations such as ex-ante volatility over portfolios. Other apps read the Parquet files straight from R2.
    <a href="/docs/" rel="external">Read the docs</a>.
  </p>
</section>

{#if error}
  <div class="error">{error}</div>
{/if}
{#if message}
  <div class="success">{message}</div>
{/if}

<section class="tiles" aria-label="Summary">
  <a class="tile card" href={href("symbols")}>
    <span class="label">Symbols</span>
    <span class="value">{formatCount(symbols.total)}</span>
    <span class="muted">{formatCount(symbols.scheduled)} on the schedule</span>
  </a>
  <a class="tile card" class:alert={symbols.failedDownloads > 0} href={href("runs", { status: "failed" })}>
    <span class="label">Failed downloads</span>
    <span class="value">{formatCount(symbols.failedDownloads)}</span>
    <span class="muted">symbols whose latest download failed</span>
  </a>
  <a class="tile card" class:alert={symbols.failedRebuilds > 0} href={href("symbols")}>
    <span class="label">Failed rebuilds</span>
    <span class="value">{formatCount(symbols.failedRebuilds)}</span>
    <span class="muted">symbols whose latest Parquet rebuild failed</span>
  </a>
  <a class="tile card" href={href("portfolios")}>
    <span class="label">Portfolios</span>
    <span class="value">{formatCount(home.portfolioCount)}</span>
  </a>
  <a class="tile card" href={href("calculations")}>
    <span class="label">Calculations</span>
    <span class="value">{formatCount(home.calculations.total)}</span>
    <span class="muted">{formatCount(home.calculations.enabled)} enabled</span>
  </a>
</section>

<div class="columns">
  <section class="card panel">
    <div class="panel-head">
      <h2>Market data</h2>
      <button onclick={runNow} disabled={busy || symbols.scheduled === 0}>
        {busy ? "Starting…" : "Run schedule now"}
      </button>
    </div>

    <p>
      {#if home.schedule.paused}
        <span class="badge-paused">Paused</span> The daily download doesn't run until it's resumed on
        <a href={href("symbols")}>Symbols</a>.
      {:else}
        Downloads daily after {hour(home.schedule.hourUtc)}.
        {#if home.schedule.nextRunAt}
          Next run
          <span title={formatDateTime(home.schedule.nextRunAt)}>{formatAgo(home.schedule.nextRunAt)}</span>.
        {/if}
      {/if}
    </p>

    {#if latestScheduleRun}
      <p class="latest">
        Latest run:
        <StatusBadge status={latestScheduleRun.status} title={latestScheduleRun.error ?? undefined} />
        <span title={formatDateTime(latestScheduleRun.createdAt)}>{formatAgo(latestScheduleRun.createdAt)}</span>
        <span class="muted">
          · {latestScheduleRun.trigger}
          {#if latestScheduleRun.queuedCount !== null}· {formatCount(latestScheduleRun.queuedCount)} queued{/if}
        </span>
      </p>
      {#if latestScheduleRun.error}
        <p class="message">{latestScheduleRun.error}</p>
      {/if}
    {:else}
      <p class="muted">The schedule hasn't run yet.</p>
    {/if}

    <h3>Latest failed downloads</h3>
    {#if home.failedRuns.length === 0}
      <p class="muted">None.</p>
    {:else}
      <ul class="list">
        {#each home.failedRuns as run (run.runId)}
          <li>
            <a href={href("runs", { symbol: run.symbol, status: "failed" })}>{run.symbol}</a>
            <span class="muted" title={formatDateTime(run.createdAt)}>{formatAgo(run.createdAt)}</span>
            {#if run.error}<span class="reason" title={run.error}>{run.error}</span>{/if}
          </li>
        {/each}
      </ul>
      <p><a href={href("runs", { status: "failed" })}>All failed runs →</a></p>
    {/if}
  </section>

  <section class="card panel">
    <div class="panel-head">
      <h2>Calculations</h2>
      <a href={href("calculations")}>All calculations →</a>
    </div>

    <h3>Latest runs</h3>
    {#if home.calculations.latestRuns.length === 0}
      <p class="muted">No calculation has run yet.</p>
    {:else}
      <ul class="list">
        {#each home.calculations.latestRuns as run (run.runId)}
          <li>
            <StatusBadge status={run.status} title={run.error ?? undefined} />
            <a href={href("calculations", { id: run.calculationId })}>{run.calculationName}</a>
            <span class="muted">
              as of <span class="mono">{run.asOf}</span> ·
              <span title={formatDateTime(run.createdAt)}>{formatAgo(run.createdAt)}</span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    <h3>Next scheduled</h3>
    {#if home.calculations.upcoming.length === 0}
      <p class="muted">No enabled calculation is scheduled.</p>
    {:else}
      <ul class="list">
        {#each home.calculations.upcoming as upcoming (upcoming.id)}
          <li>
            <a href={href("calculations", { id: upcoming.id })}>{upcoming.name}</a>
            <span class="muted mono">{upcoming.type}</span>
            <span class="when" title={formatDateTime(upcoming.nextRunAt)}>{formatAgo(upcoming.nextRunAt)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<section aria-label="Sections">
  <h2 class="sections-title">Go to</h2>
  <div class="sections">
    {#each SECTIONS as section (section.path)}
      <a class="card section" href={section.path}>
        <strong>{section.title}</strong>
        <span class="muted">{section.text}</span>
      </a>
    {/each}
    <a class="card section" href="/docs/" rel="external">
      <strong>Docs</strong>
      <span class="muted">How the service works, the management API and operations.</span>
    </a>
  </div>
</section>

{#if navigating.to}
  <p class="notice">Loading…</p>
{/if}

<style>
  .intro h1 {
    margin: 0 0 0.25rem;
    font-size: 1.5rem;
  }
  .intro p {
    margin: 0 0 1.25rem;
    max-width: 70ch;
    line-height: 1.5;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.9rem 1rem;
    color: var(--text);
    font-size: 0.85rem;
  }
  .tile:hover,
  .section:hover {
    text-decoration: none;
    border-color: var(--accent);
  }
  .tile .label {
    font-weight: 600;
    color: var(--muted);
  }
  .tile .value {
    font-size: 1.75rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .tile.alert .value {
    color: var(--bad-fg);
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .panel {
    padding: 1rem 1.25rem;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  h3 {
    margin: 1.25rem 0 0.5rem;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
  }
  .panel p {
    margin: 0.75rem 0 0;
  }
  .latest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .badge-paused {
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--warn-bg);
    color: var(--warn-fg);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .message {
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--bad-bg);
    color: var(--bad-fg);
    font-family: var(--mono);
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--border);
  }
  .list li:last-child {
    border-bottom: none;
  }
  .reason {
    flex: 1 1 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--bad-fg);
  }
  .when {
    margin-left: auto;
  }
  .sections-title {
    margin-bottom: 0.75rem;
  }
  .sections {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
    gap: 0.75rem;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.9rem 1rem;
    color: var(--text);
    font-size: 0.9rem;
  }
</style>
