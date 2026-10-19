<script lang="ts">
  import { untrack } from "svelte";

  import { fetchRuns, type IngestionRunView, type RunStatus } from "../lib/api";
  import { formatAgo, formatCount, formatDateTime, formatDuration, formatRange } from "../lib/format";
  import { href, replace, route } from "../lib/router.svelte";
  import StatusBadge from "../lib/StatusBadge.svelte";

  const STATUSES: RunStatus[] = ["fetching", "completed", "failed"];

  const symbol = $derived(route.params.get("symbol") ?? "");
  const status = $derived((route.params.get("status") ?? "") as RunStatus | "");

  let runs = $state<readonly IngestionRunView[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(null);
  let updatedAt = $state<Date | null>(null);
  let symbolInput = $state("");

  // Ignore responses to requests that a newer one replaced.
  let latestRequest = 0;

  const load = async (cursor?: string) => {
    const request = ++latestRequest;
    loading = true;
    error = null;
    try {
      const page = await fetchRuns({ symbol: symbol || undefined, status: status || undefined, cursor });
      if (request !== latestRequest) return;
      runs = cursor === undefined ? page.runs : [...runs, ...page.runs];
      nextCursor = page.nextCursor;
      updatedAt = new Date();
    } catch (cause) {
      if (request === latestRequest) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (request === latestRequest) loading = false;
    }
  };

  // Reload from the first page whenever the filters in the URL change.
  $effect(() => {
    symbolInput = symbol;
    void status;
    untrack(() => load());
  });

  const setFilter = (next: { symbol?: string; status?: string }) =>
    replace("runs", { symbol, status, ...next });

  const applySymbol = (event: SubmitEvent) => {
    event.preventDefault();
    setFilter({ symbol: symbolInput.trim().toUpperCase() });
  };

  const toggle = (runId: string) => (expanded = expanded === runId ? null : runId);
</script>

<div class="toolbar">
  <form onsubmit={applySymbol}>
    <input placeholder="Symbol, e.g. AAPL.US" bind:value={symbolInput} aria-label="Symbol" />
  </form>
  <select
    aria-label="Status"
    value={status}
    onchange={(event) => setFilter({ status: event.currentTarget.value })}
  >
    <option value="">All statuses</option>
    {#each STATUSES as option (option)}
      <option value={option}>{option}</option>
    {/each}
  </select>
  {#if symbol || status}
    <a href={href("runs")}>Clear filters</a>
  {/if}
  <span class="spacer"></span>
  {#if updatedAt}
    <span class="muted">Updated {updatedAt.toLocaleTimeString()}</span>
  {/if}
  <button onclick={() => load()} disabled={loading}>Refresh</button>
</div>

{#if error}
  <div class="error">{error}</div>
{/if}

<div class="card">
  <table>
    <thead>
      <tr>
        <th></th>
        <th>Status</th>
        <th>Symbol</th>
        <th>Started</th>
        <th class="num">Duration</th>
        <th>Requested</th>
        <th class="num">Rows</th>
        <th>Data covers</th>
        <th>Parquet</th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.runId)}
        <tr class="run" class:open={expanded === run.runId} onclick={() => toggle(run.runId)}>
          <td>
            <button
              class="expand"
              aria-expanded={expanded === run.runId}
              aria-label="Show details"
              onclick={(event) => {
                event.stopPropagation();
                toggle(run.runId);
              }}>{expanded === run.runId ? "▾" : "▸"}</button
            >
          </td>
          <td><StatusBadge status={run.status} title={run.error ?? undefined} /></td>
          <td>
            <a href={href("runs", { symbol: run.symbol, status })} onclick={(event) => event.stopPropagation()}
              >{run.symbol}</a
            >
            <span class="muted dataset">{run.dataset}</span>
          </td>
          <td title={formatDateTime(run.createdAt)}>{formatAgo(run.createdAt)}</td>
          <td class="num">{run.completedAt ? formatDuration(run.createdAt, run.completedAt) : "—"}</td>
          <td class="mono">{formatRange(run.requestedFrom, run.requestedTo)}</td>
          <td class="num">{run.rowCount === null ? "—" : formatCount(run.rowCount)}</td>
          <td class="mono">{formatRange(run.observedFrom, run.observedTo)}</td>
          <td><StatusBadge status={run.job?.status ?? null} title={run.job?.error ?? undefined} /></td>
        </tr>
        {#if expanded === run.runId}
          <tr class="details">
            <td></td>
            <td colspan="8">
              {#if run.error}
                <p class="message">{run.error}</p>
              {/if}
              <dl>
                <dt>Run ID</dt>
                <dd class="mono">{run.runId}</dd>
                <dt>Provider</dt>
                <dd>{run.provider}</dd>
                <dt>Started</dt>
                <dd>{formatDateTime(run.createdAt)}</dd>
                <dt>Finished</dt>
                <dd>{run.completedAt ? formatDateTime(run.completedAt) : "—"}</dd>
                <dt>Raw object</dt>
                <dd class="mono">{run.objectKey ?? "—"}</dd>
                {#if run.job}
                  <dt>Processing job</dt>
                  <dd>
                    <span class="mono">{run.job.jobId}</span>
                    · <StatusBadge status={run.job.status} />
                    · queued {formatDateTime(run.job.createdAt)}
                    {#if run.job.startedAt && run.job.completedAt}
                      · took {formatDuration(run.job.startedAt, run.job.completedAt)}
                    {/if}
                  </dd>
                  {#if run.job.error}
                    <dt>Job error</dt>
                    <dd><p class="message">{run.job.error}</p></dd>
                  {/if}
                {/if}
              </dl>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>

  {#if runs.length === 0 && !loading && !error}
    <p class="notice">No ingestion runs{symbol || status ? " match these filters" : " yet"}.</p>
  {/if}
</div>

{#if nextCursor || (loading && runs.length > 0)}
  <div class="more">
    <button onclick={() => load(nextCursor ?? undefined)} disabled={loading}>
      {loading ? "Loading…" : "Load older runs"}
    </button>
  </div>
{:else if loading}
  <p class="notice">Loading…</p>
{/if}

<style>
  form {
    display: contents;
  }
  tr.run {
    cursor: pointer;
  }
  tr.run:hover,
  tr.run.open {
    background: var(--row-hover);
  }
  tr.run.open td {
    border-bottom: none;
  }
  .expand {
    border: none;
    background: none;
    padding: 0 0.25rem;
    color: var(--muted);
  }
  .dataset {
    margin-left: 0.4rem;
    font-size: 0.8rem;
  }
  tr.details {
    background: var(--row-hover);
  }
  tr.details td {
    white-space: normal;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1.5rem;
    margin: 0 0 0.5rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .message {
    margin: 0 0 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--bad-bg);
    color: var(--bad-fg);
    font-family: var(--mono);
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  dd .message {
    margin: 0;
  }
  .more {
    display: flex;
    justify-content: center;
    margin-top: 1rem;
  }
</style>
