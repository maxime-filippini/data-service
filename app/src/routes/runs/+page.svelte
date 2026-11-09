<script lang="ts">
  import { refreshAll } from "$app/navigation";
  import { navigating } from "$app/state";

  import { fetchRuns, type RunStatus } from "#lib/api.ts";
  import { formatAgo, formatCount, formatDateTime, formatDuration, formatRange } from "#lib/format.ts";
  import { href, replace, route } from "#lib/router.svelte.ts";
  import StatusBadge from "#lib/StatusBadge.svelte";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const STATUSES: RunStatus[] = ["fetching", "completed", "failed"];

  const symbol = $derived(route.params.get("symbol") ?? "");
  const status = $derived((route.params.get("status") ?? "") as RunStatus | "");

  // The server loads the first page for the filters in the URL; older pages
  // are appended here.
  let runs = $derived(data.page.runs);
  let nextCursor = $derived(data.page.nextCursor);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(null);
  const updatedAt = $derived.by(() => (void data, new Date()));
  let symbolInput = $derived(symbol);

  const loading = $derived(loadingMore || navigating.to !== null);

  const loadMore = async () => {
    if (nextCursor === null) return;
    loadingMore = true;
    error = null;
    try {
      const page = await fetchRuns({ symbol: symbol || undefined, status: status || undefined, cursor: nextCursor });
      runs = [...runs, ...page.runs];
      nextCursor = page.nextCursor;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loadingMore = false;
    }
  };

  const refresh = () => {
    error = null;
    return refreshAll();
  };

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
  <span class="muted">Updated {updatedAt.toLocaleTimeString()}</span>
  <button onclick={refresh} disabled={loading}>Refresh</button>
</div>

{#if error}
  <div class="error">{error}</div>
{/if}

<div class="card">
  <table class="stack">
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
          <td class="toggle">
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
          <td class="status"><StatusBadge status={run.status} title={run.error ?? undefined} /></td>
          <td class="symbol">
            <a href={href("runs", { symbol: run.symbol, status })} onclick={(event) => event.stopPropagation()}
              >{run.symbol}</a
            >
            <span class="muted dataset">{run.dataset}</span>
          </td>
          <td data-label="Started" title={formatDateTime(run.createdAt)}>{formatAgo(run.createdAt)}</td>
          <td data-label="Duration" class="num">
            {run.completedAt ? formatDuration(run.createdAt, run.completedAt) : "—"}
          </td>
          <td class="mono wide-only">{formatRange(run.requestedFrom, run.requestedTo)}</td>
          <td data-label="Rows" class="num">{run.rowCount === null ? "—" : formatCount(run.rowCount)}</td>
          <td data-label="Data covers" class="mono full">{formatRange(run.observedFrom, run.observedTo)}</td>
          <td data-label="Parquet">
            <StatusBadge status={run.job?.status ?? null} title={run.job?.error ?? undefined} />
          </td>
        </tr>
        {#if expanded === run.runId}
          <tr class="details">
            <td class="wide-only"></td>
            <td class="full" colspan="8">
              {#if run.error}
                <p class="message">{run.error}</p>
              {/if}
              <dl>
                <dt>Run ID</dt>
                <dd class="mono">{run.runId}</dd>
                <dt class="narrow-only">Requested</dt>
                <dd class="narrow-only mono">{formatRange(run.requestedFrom, run.requestedTo)}</dd>
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
    <button onclick={loadMore} disabled={loading}>
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
  dd.mono {
    overflow-wrap: anywhere;
  }
  .more {
    display: flex;
    justify-content: center;
    margin-top: 1rem;
  }

  /* Phones: each run is a card with the symbol and status on top. The toggle
     spans every row so the fields line up under the symbol. */
  @media (max-width: 720px) {
    form input {
      flex: 1 1 12rem;
      min-width: 0;
    }
    tr.run {
      grid-template-columns: auto repeat(2, minmax(0, 1fr));
      grid-auto-flow: row dense;
      column-gap: 0.75rem;
    }
    tr.run.open {
      border-bottom: none;
    }
    .toggle {
      grid-column: 1;
      grid-row: 1 / span 4;
    }
    .expand {
      min-height: 0;
      padding: 0;
    }
    .symbol {
      grid-column: 2;
      grid-row: 1;
      font-weight: 600;
    }
    .dataset {
      display: block;
      margin-left: 0;
      font-weight: normal;
    }
    .status {
      grid-column: 3;
      grid-row: 1;
      justify-self: end;
    }
    tr.run td.full {
      grid-column: 2 / span 2;
    }
    tr.details {
      padding-top: 0;
    }
    dl {
      grid-template-columns: 1fr;
      gap: 0;
    }
    dt {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    dd + dt {
      margin-top: 0.6rem;
    }
  }
</style>
