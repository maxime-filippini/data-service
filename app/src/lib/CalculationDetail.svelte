<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";

  import {
    type Calculation,
    type CalculationRun,
    type CalculationTypeInfo,
    deleteCalculation,
    fetchCalculation,
    fetchCalculationRuns,
    type PortfolioSummary,
    startCalculationRun,
    updateCalculation,
  } from "./api";
  import CalculationForm from "./CalculationForm.svelte";
  import { formatAgo, formatCount, formatDateTime, formatDuration } from "./format";
  import { formatParams } from "./params";
  import { href } from "./router.svelte";
  import StatusBadge from "./StatusBadge.svelte";

  let {
    calculation: initialCalculation,
    runs: initialRuns,
    types,
    portfolios,
    ondeleted,
  }: {
    /** As loaded with the page; reloaded here after each change. */
    calculation: Calculation;
    runs: readonly CalculationRun[];
    types: readonly CalculationTypeInfo[];
    portfolios: readonly PortfolioSummary[];
    /** Called with the calculation's name once it's deleted. */
    ondeleted: (name: string) => void;
  } = $props();

  /** How often to check on a running run. */
  const POLL_MS = 5000;

  let calculation = $derived<Calculation | null>(initialCalculation);
  let runs = $derived<readonly CalculationRun[]>(initialRuns);
  const id = $derived(initialCalculation.id);
  let loading = $state(false);
  let busy = $state(false);
  let editing = $state(false);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let asOf = $state("");
  /** Runs whose details are shown. */
  const open = new SvelteSet<string>();

  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  const load = async () => {
    loading = true;
    try {
      const [found, history] = await Promise.all([fetchCalculation(id), fetchCalculationRuns(id, 50)]);
      calculation = found;
      runs = history.runs;
    } catch (cause) {
      error = describe(cause);
    } finally {
      loading = false;
    }
  };
  // Check again while a run is going, so its outcome shows up on its own.
  const running = $derived(runs.some((run) => run.status === "running"));
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  });

  const info = $derived(types.find((type) => type.name === calculation?.type));
  const portfolioNames = $derived(new Map(portfolios.map((p) => [p.id, p.name])));
  /** The previous UTC day, which runs default to. */
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

  const act = async (action: () => Promise<string | null>) => {
    busy = true;
    error = null;
    message = null;
    try {
      message = await action();
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  };

  const runNow = (event: SubmitEvent) => {
    event.preventDefault();
    return act(async () => {
      const started = await startCalculationRun(id, asOf || undefined);
      open.add(started.runId);
      await load();
      return started.status === "skipped"
        ? "Skipped: this calculation already has a run going. The skipped run is recorded below."
        : `Started a run as of ${asOf || yesterday}.`;
    });
  };

  const setEnabled = (enabled: boolean) =>
    act(async () => {
      calculation = await updateCalculation(id, { enabled });
      return enabled ? "Enabled: it runs on its cron again." : "Paused: it won't run on its cron until enabled.";
    });

  const remove = () => {
    if (!calculation) return;
    const { name } = calculation;
    if (!confirm(`Delete ${name} and its run history? Its results file stays in R2.`)) return;
    return act(async () => {
      await deleteCalculation(id);
      ondeleted(name);
      return null;
    });
  };

  const toggle = (runId: string) => (open.has(runId) ? open.delete(runId) : open.add(runId));

  const portfolioLabel = (portfolioId: string | null) =>
    portfolioId === null ? "No portfolio" : (portfolioNames.get(portfolioId) ?? portfolioId);

  const failedCount = (run: CalculationRun) => run.portfolios?.filter((p) => p.status === "failed").length ?? 0;
</script>

<p class="back"><a href={href("calculations")}>← Calculations</a></p>

{#if calculation && editing}
  <CalculationForm
    {types}
    {portfolios}
    initial={calculation}
    onsaved={(saved) => {
      calculation = saved;
      editing = false;
      message = "Saved. Earlier results and runs are unchanged.";
    }}
    oncancel={() => (editing = false)}
  />
{:else if calculation}
  <div class="title-row">
    <h1>{calculation.name}</h1>
    <span class="state" class:paused={!calculation.enabled}>{calculation.enabled ? "Enabled" : "Paused"}</span>
    <span class="spacer"></span>
    <button onclick={() => ((editing = true), (message = null), (error = null))}>Edit</button>
    <button onclick={() => setEnabled(!calculation?.enabled)} disabled={busy}>
      {calculation.enabled ? "Pause" : "Enable"}
    </button>
    <button onclick={remove} disabled={busy}>Delete</button>
  </div>

  <div class="card facts">
    <dl>
      <div>
        <dt>Type</dt>
        <dd class="mono">{calculation.type}</dd>
      </div>
      <div>
        <dt>Cron (UTC)</dt>
        <dd class="mono">{calculation.cron}</dd>
      </div>
      <div>
        <dt>Last scheduled slot</dt>
        <dd>
          {#if calculation.lastScheduledSlot}
            <span title={calculation.lastScheduledSlot}>{formatDateTime(calculation.lastScheduledSlot)}</span>
          {:else}
            <span class="muted">None yet</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt>Updated</dt>
        <dd title={formatDateTime(calculation.updatedAt)}>{formatAgo(calculation.updatedAt)}</dd>
      </div>
      <div class="wide">
        <dt>Portfolios</dt>
        <dd>
          {#each calculation.portfolioIds as portfolioId, index (portfolioId)}
            {#if index > 0}{", "}{/if}<a href={href("portfolios", { id: portfolioId })}>{portfolioLabel(portfolioId)}</a>
          {:else}
            <span class="muted">None (this type doesn't take a portfolio)</span>
          {/each}
        </dd>
      </div>
      <div class="wide">
        <dt>Results</dt>
        <dd>
          <a href={href("explore", { calculation: calculation.id })}>Explore results</a>
          <span class="muted mono key">{calculation.outputKey}</span>
        </dd>
      </div>
    </dl>
    {#if !info && types.length > 0}
      <p class="bad">The engine has no type called {calculation.type}, so runs of this calculation fail.</p>
    {/if}
    <details>
      <summary>Params</summary>
      <pre>{formatParams(calculation.params)}</pre>
    </details>
  </div>
{:else if loading}
  <p class="notice">Loading…</p>
{/if}

{#if error}
  <div class="error">{error}</div>
{/if}
{#if message}
  <div class="success">{message}</div>
{/if}

{#if calculation}
  <form class="toolbar run-now" onsubmit={runNow}>
    <h2>Runs</h2>
    <span class="spacer"></span>
    <label class="muted as-of">
      As of
      <input type="date" bind:value={asOf} max={new Date().toISOString().slice(0, 10)} aria-label="As-of date" />
    </label>
    <button type="submit" class="primary" disabled={busy}>Run now</button>
    <button type="button" onclick={() => load()} disabled={loading}>Refresh</button>
  </form>
  <p class="muted hint">
    Leave the date empty to run as of the previous UTC day ({yesterday}). A run replaces its as-of date's rows in the
    results, so running a date again is safe.
  </p>

  <div class="card">
    <table class="stack">
      <thead>
        <tr>
          <th>Started</th>
          <th>Trigger</th>
          <th>As of</th>
          <th>Status</th>
          <th class="num">Rows</th>
          <th>Took</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.runId)}
          {@const expanded = open.has(run.runId)}
          {@const failed = failedCount(run)}
          <tr class="run" class:expanded>
            <td data-label="Started" title={formatDateTime(run.createdAt)}>{formatAgo(run.createdAt)}</td>
            <td data-label="Trigger">{run.trigger === "manual" ? "Manual" : "Schedule"}</td>
            <td data-label="As of" class="mono">{run.asOf}</td>
            <td data-label="Status">
              <StatusBadge status={run.status} />
              {#if failed > 0}<span class="bad small">{failed} failed</span>{/if}
            </td>
            <td data-label="Rows" class="num">{run.rowCount === null ? "—" : formatCount(run.rowCount)}</td>
            <td data-label="Took">
              {run.completedAt && run.status !== "skipped" ? formatDuration(run.createdAt, run.completedAt) : "—"}
            </td>
            <td class="full toggle">
              <button class="link" onclick={() => toggle(run.runId)} aria-expanded={expanded}>
                {expanded ? "Hide details" : "Details"}
              </button>
            </td>
          </tr>
          {#if run.error && !expanded}
            <tr class="error-row">
              <td colspan="7" class="full bad">{run.error}</td>
            </tr>
          {/if}
          {#if expanded}
            <tr class="details">
              <td colspan="7" class="full">
                {#if run.error}
                  <p class="bad">{run.error}</p>
                {/if}
                {#if run.status === "skipped"}
                  <p class="muted">Skipped because another run of this calculation was still going.</p>
                {/if}
                {#if run.portfolios && run.portfolios.length > 0}
                  <table class="outcomes">
                    <thead>
                      <tr>
                        <th>Portfolio</th>
                        <th>Status</th>
                        <th class="num">Rows</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each run.portfolios as outcome, index (`${outcome.portfolioId}-${index}`)}
                        <tr>
                          <td>
                            {#if outcome.portfolioId}
                              <a href={href("portfolios", { id: outcome.portfolioId })}>{portfolioLabel(outcome.portfolioId)}</a>
                            {:else}
                              <span class="muted">{portfolioLabel(null)}</span>
                            {/if}
                          </td>
                          <td><StatusBadge status={outcome.status} /></td>
                          <td class="num">{formatCount(outcome.rowCount)}</td>
                          <td class="bad wrap">{outcome.error ?? ""}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {:else if run.status === "running"}
                  <p class="muted">Running. Each portfolio's outcome shows here when it finishes.</p>
                {/if}
                <p class="muted small">
                  Run <span class="mono">{run.runId}</span> · started {formatDateTime(run.createdAt)}
                  {#if run.completedAt}· finished {formatDateTime(run.completedAt)}{/if}
                </p>
                <p class="label">Params used</p>
                <pre>{formatParams(run.params)}</pre>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if runs.length === 0 && !loading}
      <p class="notice">No runs yet. Use Run now, or wait for its cron.</p>
    {/if}
  </div>
{/if}

<style>
  .back {
    margin: 0 0 0.5rem;
  }
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .title-row .spacer {
    flex: 1;
  }
  h1 {
    margin: 0;
    font-size: 1.35rem;
    overflow-wrap: anywhere;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
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
  .facts {
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem 1.5rem;
    margin: 0;
  }
  dl .wide {
    grid-column: span 2;
  }
  dt {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
  }
  dd {
    margin: 0.1rem 0 0;
    overflow-wrap: anywhere;
  }
  .key {
    display: block;
  }
  details {
    margin-top: 0.75rem;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
  }
  pre {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--bg);
    font-size: 0.8rem;
    overflow: auto;
    white-space: pre;
  }
  .run-now {
    margin-bottom: 0.25rem;
  }
  .as-of {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .hint {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
  }
  .bad {
    color: var(--bad-fg);
  }
  .small {
    font-size: 0.8rem;
  }
  tr.expanded td,
  tr.details > td {
    background: var(--row-hover);
  }
  tr.run:has(+ tr.error-row) td {
    border-bottom: none;
  }
  tr.error-row td {
    padding-top: 0;
    white-space: normal;
    font-size: 0.85rem;
  }
  tr.details > td {
    white-space: normal;
  }
  tr.details p {
    margin: 0 0 0.5rem;
  }
  .label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
  }
  table.outcomes {
    width: auto;
    margin-bottom: 0.75rem;
  }
  table.outcomes th,
  table.outcomes td {
    padding: 0.3rem 1.25rem 0.3rem 0;
    background: none;
  }
  .wrap {
    white-space: normal;
  }
  .toggle {
    text-align: right;
  }

  @media (max-width: 900px) {
    dl {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 720px) {
    .as-of {
      flex: 1 1 12rem;
    }
    .as-of input {
      flex: 1;
      min-width: 0;
    }
    .run-now h2 {
      flex-basis: 100%;
    }
    .toggle {
      text-align: left;
    }
    tr.error-row,
    tr.details {
      display: block;
      padding-top: 0;
    }
    tr.run:has(+ tr.error-row) {
      border-bottom: none;
    }
    tr.expanded,
    tr.details {
      background: var(--row-hover);
    }
    tr.expanded td,
    tr.details > td {
      background: none;
    }
    table.outcomes {
      width: 100%;
    }
    table.outcomes thead {
      display: none;
    }
    table.outcomes tr {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.75rem;
      padding: 0.4rem 0;
      border-bottom: 1px solid var(--border);
    }
    table.outcomes td {
      padding: 0;
      border: none;
    }
    table.outcomes td.wrap {
      flex-basis: 100%;
    }
  }
</style>
