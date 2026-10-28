<script lang="ts">
  import {
    createPortfolio,
    fetchPortfolios,
    fetchSymbols,
    type PortfolioSummary,
  } from "../lib/api";
  import { formatAgo, formatDateTime } from "../lib/format";
  import { emptyRow, type HoldingRow, toHoldings } from "../lib/holdings";
  import HoldingsEditor from "../lib/HoldingsEditor.svelte";
  import PortfolioDetail from "../lib/PortfolioDetail.svelte";
  import { href, route } from "../lib/router.svelte";

  const id = $derived(route.params.get("id") ?? "");

  let portfolios = $state<PortfolioSummary[]>([]);
  /** Tracked prices_eod symbols, suggested in the holdings editor. */
  let symbols = $state<string[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let search = $state("");
  /** Single-asset portfolios come one per symbol, so they can be hidden. */
  let showSingleAsset = $state(true);

  let creating = $state(false);
  let saving = $state(false);
  let formError = $state<string | null>(null);
  let name = $state("");
  let withSnapshot = $state(true);
  let holdingsDate = $state(new Date().toISOString().slice(0, 10));
  let rows = $state<HoldingRow[]>([emptyRow()]);

  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  let latestRequest = 0;
  const load = async () => {
    const request = ++latestRequest;
    loading = true;
    try {
      const result = await fetchPortfolios();
      if (request === latestRequest) portfolios = result.portfolios;
    } catch (cause) {
      if (request === latestRequest) error = describe(cause);
    } finally {
      if (request === latestRequest) loading = false;
    }
  };

  // Reload the list when coming back from a portfolio, which may have changed it.
  $effect(() => {
    if (id === "") void load();
    else error = null;
  });

  fetchSymbols({})
    .then((result) => (symbols = result.symbols.filter((s) => s.dataset === "prices_eod").map((s) => s.symbol)))
    .catch(() => undefined);

  const visible = $derived(
    portfolios.filter(
      (p) =>
        (showSingleAsset || p.assetSymbol === null) &&
        (search.trim() === "" || p.name.toLowerCase().includes(search.trim().toLowerCase())),
    ),
  );

  const openForm = () => {
    creating = true;
    formError = null;
    message = null;
    error = null;
    name = "";
    withSnapshot = true;
    rows = [emptyRow()];
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    formError = null;
    let snapshot;
    if (withSnapshot) {
      const parsed = toHoldings(rows);
      if ("error" in parsed) {
        formError = parsed.error;
        return;
      }
      snapshot = { holdingsDate, holdings: parsed.holdings };
    }
    saving = true;
    try {
      const created = await createPortfolio({ name, ...(snapshot ? { snapshot } : {}) });
      creating = false;
      window.location.hash = href("portfolios", { id: created.id });
    } catch (cause) {
      formError = describe(cause);
    } finally {
      saving = false;
    }
  };
</script>

{#if id}
  {#key id}
    <PortfolioDetail
      {id}
      {symbols}
      ondeleted={(deleted) => {
        message = `Deleted ${deleted}.`;
        window.location.hash = href("portfolios");
      }}
    />
  {/key}
{:else}
  <div class="toolbar">
    <input placeholder="Search portfolios" bind:value={search} aria-label="Search portfolios" />
    <label class="check">
      <input type="checkbox" bind:checked={showSingleAsset} />
      Single-asset
    </label>
    <span class="spacer"></span>
    <button onclick={openForm} disabled={creating}>New portfolio</button>
    <button onclick={() => load()} disabled={loading}>Refresh</button>
  </div>

  {#if creating}
    <form class="card form" onsubmit={submit}>
      <h2>New portfolio</h2>
      <label class="field name">
        Name
        <input bind:value={name} required maxlength="200" placeholder="Core equity" />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={withSnapshot} />
        Add its first holdings snapshot now
      </label>
      {#if withSnapshot}
        <label class="field date">
          Holdings date
          <input type="date" bind:value={holdingsDate} required />
        </label>
        <HoldingsEditor bind:rows {symbols} />
      {/if}
      <p class="muted hint">
        Every symbol must be tracked in prices_eod. Weights can be any non-zero numbers; they don't need to sum to 1.
      </p>
      {#if formError}
        <div class="error">{formError}</div>
      {/if}
      <div class="actions">
        <button type="button" onclick={() => (creating = false)} disabled={saving}>Cancel</button>
        <button type="submit" class="primary" disabled={saving || name.trim() === ""}>
          {saving ? "Creating…" : "Create portfolio"}
        </button>
      </div>
    </form>
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
          <th class="num">Snapshots</th>
          <th>Latest holdings</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {#each visible as p (p.id)}
          <tr>
            <td class="full name-cell">
              <a href={href("portfolios", { id: p.id })}>{p.name}</a>
              {#if p.assetSymbol !== null}<span class="muted kind">single asset</span>{/if}
            </td>
            <td data-label="Snapshots" class="num">{p.snapshotCount}</td>
            <td data-label="Latest holdings" class="mono">{p.latestHoldingsDate ?? "—"}</td>
            <td data-label="Updated" title={formatDateTime(p.updatedAt)}>{formatAgo(p.updatedAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if visible.length === 0 && !loading && !error}
      <p class="notice">
        {portfolios.length === 0 ? "No portfolios yet. Create one to run calculations over it." : "No portfolios match."}
      </p>
    {:else if loading && portfolios.length === 0}
      <p class="notice">Loading…</p>
    {/if}
  </div>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .name {
    max-width: 24rem;
  }
  .date {
    max-width: 12rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .hint {
    margin: 0;
    font-size: 0.85rem;
  }
  .form .error {
    margin: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .name-cell {
    font-weight: 600;
  }
  .kind {
    margin-left: 0.4rem;
    font-weight: 400;
    font-size: 0.85rem;
  }

  @media (max-width: 720px) {
    .name,
    .date {
      max-width: none;
    }
    .actions button {
      flex: 1;
    }
  }
</style>
