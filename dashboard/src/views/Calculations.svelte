<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";

  import {
    type Calculation,
    type CalculationTypeInfo,
    fetchCalculations,
    fetchCalculationTypes,
    fetchPortfolios,
    type PortfolioSummary,
    updateCalculation,
  } from "../lib/api";
  import CalculationDetail from "../lib/CalculationDetail.svelte";
  import CalculationForm from "../lib/CalculationForm.svelte";
  import { formatAgo, formatDateTime } from "../lib/format";
  import { href, route } from "../lib/router.svelte";
  import StatusBadge from "../lib/StatusBadge.svelte";

  const id = $derived(route.params.get("id") ?? "");

  let calculations = $state<Calculation[]>([]);
  let types = $state<CalculationTypeInfo[]>([]);
  let portfolios = $state<PortfolioSummary[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let typesError = $state<string | null>(null);
  let message = $state<string | null>(null);
  let search = $state("");
  let creating = $state(false);
  /** Calculations with a request in flight. */
  const pending = new SvelteSet<string>();

  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  let latestRequest = 0;
  const load = async () => {
    const request = ++latestRequest;
    loading = true;
    try {
      const [calcs, owned] = await Promise.all([fetchCalculations(), fetchPortfolios()]);
      if (request !== latestRequest) return;
      calculations = calcs.calculations;
      portfolios = owned.portfolios;
    } catch (cause) {
      if (request === latestRequest) error = describe(cause);
    } finally {
      if (request === latestRequest) loading = false;
    }
  };

  // The engine may be starting up, so its types load on their own.
  const loadTypes = async () => {
    typesError = null;
    try {
      types = (await fetchCalculationTypes()).types;
    } catch (cause) {
      typesError = `Could not load calculation types from the engine: ${describe(cause)}`;
    }
  };
  void loadTypes();

  // Reload on every page change: the detail page needs the portfolio names,
  // and the list may have changed after an edit.
  $effect(() => {
    void id;
    error = null;
    void load();
  });

  const visible = $derived(
    calculations.filter(
      (c) =>
        search.trim() === "" ||
        `${c.name} ${c.type}`.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );

  const toggleEnabled = async (calculation: Calculation) => {
    pending.add(calculation.id);
    error = null;
    message = null;
    try {
      await updateCalculation(calculation.id, { enabled: !calculation.enabled });
      await load();
    } catch (cause) {
      error = describe(cause);
    } finally {
      pending.delete(calculation.id);
    }
  };
</script>

{#if id}
  {#key id}
    <CalculationDetail
      {id}
      {types}
      {portfolios}
      ondeleted={(name) => {
        message = `Deleted ${name}. Its results stay in R2.`;
        window.location.hash = href("calculations");
      }}
    />
  {/key}
{:else}
  <div class="toolbar">
    <input placeholder="Search calculations" bind:value={search} aria-label="Search calculations" />
    <span class="spacer"></span>
    <button
      onclick={() => ((creating = true), (message = null), (error = null))}
      disabled={creating || types.length === 0}
      title={types.length === 0 ? "Waiting for the engine's calculation types" : undefined}
    >
      New calculation
    </button>
    <button onclick={() => (load(), types.length === 0 && loadTypes())} disabled={loading}>Refresh</button>
  </div>

  {#if typesError}
    <div class="error">{typesError}</div>
  {/if}

  {#if creating}
    <CalculationForm
      {types}
      {portfolios}
      onsaved={(saved) => {
        creating = false;
        window.location.hash = href("calculations", { id: saved.id });
      }}
      oncancel={() => (creating = false)}
    />
  {/if}

  {#if error}
    <div class="error">{error}</div>
  {/if}
  {#if message}
    <div class="success">{message}</div>
  {/if}

  <div class="card">
    <table class="stack">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th class="num">Portfolios</th>
          <th>Cron (UTC)</th>
          <th>Enabled</th>
          <th>Last run</th>
        </tr>
      </thead>
      <tbody>
        {#each visible as c (c.id)}
          <tr class="entry" class:disabled={!c.enabled}>
            <td class="name"><a href={href("calculations", { id: c.id })}>{c.name}</a></td>
            <td data-label="Type" class="mono">{c.type}</td>
            <td data-label="Portfolios" class="num">{c.portfolioIds.length || "—"}</td>
            <td data-label="Cron (UTC)" class="mono">{c.cron}</td>
            <td class="enabled">
              <label class="switch" title={c.enabled ? "Pause its schedule" : "Run it on its cron"}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${c.name} enabled`}
                  checked={c.enabled}
                  disabled={pending.has(c.id)}
                  onchange={() => toggleEnabled(c)}
                />
                <span>{c.enabled ? "On" : "Paused"}</span>
              </label>
            </td>
            <td data-label="Last run" class="full">
              {#if c.lastRun}
                <StatusBadge status={c.lastRun.status} title={c.lastRun.error ?? undefined} />
                <span class="muted">
                  as of <span class="mono">{c.lastRun.asOf}</span> ·
                  <span title={formatDateTime(c.lastRun.createdAt)}>{formatAgo(c.lastRun.createdAt)}</span>
                </span>
              {:else}
                <span class="muted">Never</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if visible.length === 0 && !loading && !error}
      <p class="notice">
        {calculations.length === 0 ? "No calculations yet." : "No calculations match."}
      </p>
    {:else if loading && calculations.length === 0}
      <p class="notice">Loading…</p>
    {/if}
  </div>
{/if}

<style>
  .name {
    font-weight: 600;
  }
  tr.disabled td {
    color: var(--muted);
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
  }

  /* Phones: name and switch on top, then the details. */
  @media (max-width: 720px) {
    tr.entry {
      grid-auto-flow: row dense;
    }
    .name {
      grid-column: 1;
      grid-row: 1;
    }
    .enabled {
      grid-column: 2;
      grid-row: 1;
      justify-self: end;
    }
  }
</style>
