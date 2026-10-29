<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";

  import {
    addSnapshot,
    deletePortfolio,
    deleteSnapshot,
    fetchPortfolio,
    type Portfolio,
    renamePortfolio,
  } from "./api";
  import { formatAgo, formatDateTime } from "./format";
  import { emptyRow, type HoldingRow, toHoldings, toRows, totalWeight } from "./holdings";
  import HoldingsEditor from "./HoldingsEditor.svelte";
  import { href } from "./router.svelte";

  let {
    portfolio: initial,
    symbols,
    ondeleted,
  }: {
    /** As loaded with the page; reloaded here after each change. */
    portfolio: Portfolio;
    symbols: readonly string[];
    /** Called with the portfolio's name once it's deleted. */
    ondeleted: (name: string) => void;
  } = $props();

  let portfolio = $derived<Portfolio | null>(initial);
  const id = $derived(initial.id);
  let loading = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);

  let renaming = $state(false);
  let newName = $state("");

  let adding = $state(false);
  let addError = $state<string | null>(null);
  let holdingsDate = $state(new Date().toISOString().slice(0, 10));
  let rows = $state<HoldingRow[]>([emptyRow()]);

  /**
   * Holdings dates whose holdings are shown: the latest snapshot's at first.
   * The page re-creates this component for another portfolio.
   */
  const open = new SvelteSet<string>(untrack(() => initial.snapshots.slice(-1).map((s) => s.holdingsDate)));

  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  const load = async () => {
    loading = true;
    try {
      portfolio = await fetchPortfolio(id);
    } catch (cause) {
      error = describe(cause);
    } finally {
      loading = false;
    }
  };
  /** Newest first. */
  const snapshots = $derived([...(portfolio?.snapshots ?? [])].reverse());

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

  const rename = (event: SubmitEvent) => {
    event.preventDefault();
    return act(async () => {
      portfolio = await renamePortfolio(id, newName);
      renaming = false;
      return `Renamed to ${portfolio.name}.`;
    });
  };

  const remove = () => {
    if (!portfolio) return;
    const { name, snapshots: all } = portfolio;
    if (!confirm(`Delete ${name} and its ${all.length} snapshot${all.length === 1 ? "" : "s"}?`)) return;
    return act(async () => {
      await deletePortfolio(id);
      ondeleted(name);
      return null;
    });
  };

  const openAdd = (from: "latest" | "empty") => {
    adding = true;
    addError = null;
    message = null;
    const latest = portfolio?.snapshots.at(-1);
    rows = from === "latest" && latest ? toRows(latest.holdings) : [emptyRow()];
    holdingsDate = new Date().toISOString().slice(0, 10);
  };

  const submitSnapshot = async (event: SubmitEvent) => {
    event.preventDefault();
    addError = null;
    const parsed = toHoldings(rows);
    if ("error" in parsed) {
      addError = parsed.error;
      return;
    }
    busy = true;
    try {
      const added = await addSnapshot(id, { holdingsDate, holdings: parsed.holdings });
      adding = false;
      message = `Added the ${added.holdingsDate} snapshot.`;
      open.add(added.holdingsDate);
      await load();
    } catch (cause) {
      addError = describe(cause);
    } finally {
      busy = false;
    }
  };

  const removeSnapshot = (holdingsDate: string) => {
    if (!confirm(`Delete the ${holdingsDate} snapshot? Earlier results aren't changed.`)) return;
    return act(async () => {
      await deleteSnapshot(id, holdingsDate);
      open.delete(holdingsDate);
      await load();
      return `Deleted the ${holdingsDate} snapshot.`;
    });
  };

  const toggle = (holdingsDate: string) => (open.has(holdingsDate) ? open.delete(holdingsDate) : open.add(holdingsDate));

  const weight = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 });
</script>

<p class="back"><a href={href("portfolios")}>← Portfolios</a></p>

{#if portfolio}
  <div class="title-row">
    {#if renaming}
      <form class="rename" onsubmit={rename}>
        <input bind:value={newName} required maxlength="200" aria-label="Portfolio name" />
        <button type="submit" class="primary" disabled={busy || newName.trim() === ""}>Save</button>
        <button type="button" onclick={() => (renaming = false)} disabled={busy}>Cancel</button>
      </form>
    {:else}
      <h1>{portfolio.name}</h1>
      <span class="spacer"></span>
      <button onclick={() => ((renaming = true), (newName = portfolio?.name ?? ""))}>Rename</button>
      <button onclick={remove} disabled={busy}>Delete</button>
    {/if}
  </div>
  <p class="muted meta">
    Created {formatDateTime(portfolio.createdAt)} · updated {formatAgo(portfolio.updatedAt)}
  </p>
{:else if loading}
  <p class="notice">Loading…</p>
{/if}

{#if error}
  <div class="error">{error}</div>
{/if}
{#if message}
  <div class="success">{message}</div>
{/if}

{#if portfolio}
  <div class="toolbar">
    <h2>Holdings snapshots</h2>
    <span class="spacer"></span>
    {#if !adding}
      {#if portfolio.snapshots.length > 0}
        <button onclick={() => openAdd("latest")}>Add snapshot from latest</button>
      {/if}
      <button onclick={() => openAdd("empty")}>Add empty snapshot</button>
    {/if}
  </div>

  {#if adding}
    <form class="card form" onsubmit={submitSnapshot}>
      <h3>New snapshot</h3>
      <label class="field date">
        Holdings date
        <input type="date" bind:value={holdingsDate} required />
      </label>
      <HoldingsEditor bind:rows {symbols} />
      <p class="muted hint">
        The holdings at the close of this date, in effect until the next snapshot. Snapshots can't be edited: to fix
        one, delete it and add it again.
      </p>
      {#if addError}
        <div class="error">{addError}</div>
      {/if}
      <div class="actions">
        <button type="button" onclick={() => (adding = false)} disabled={busy}>Cancel</button>
        <button type="submit" class="primary" disabled={busy}>Add snapshot</button>
      </div>
    </form>
  {/if}

  <div class="card">
    {#each snapshots as snapshot (snapshot.holdingsDate)}
      {@const expanded = open.has(snapshot.holdingsDate)}
      <section class="snapshot">
        <div class="snapshot-head">
          <button class="link date-toggle" onclick={() => toggle(snapshot.holdingsDate)} aria-expanded={expanded}>
            <span class="caret">{expanded ? "▾" : "▸"}</span>
            <span class="mono">{snapshot.holdingsDate}</span>
          </button>
          <span class="muted">
            {snapshot.holdings.length} holding{snapshot.holdings.length === 1 ? "" : "s"} · weights sum to
            {weight.format(totalWeight(snapshot.holdings))}
          </span>
          <span class="spacer"></span>
          <span class="muted added" title={formatDateTime(snapshot.createdAt)}>added {formatAgo(snapshot.createdAt)}</span>
          <button class="link danger" onclick={() => removeSnapshot(snapshot.holdingsDate)} disabled={busy}>
            Delete
          </button>
        </div>
        {#if expanded}
          <table class="holdings">
            <thead>
              <tr>
                <th>Symbol</th>
                <th class="num">Weight</th>
              </tr>
            </thead>
            <tbody>
              {#each snapshot.holdings as holding (holding.symbol)}
                <tr>
                  <td class="mono">{holding.symbol}</td>
                  <td class="num">{weight.format(holding.weight)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>
    {:else}
      <p class="notice">No snapshots yet. Calculations fail for this portfolio until it has one.</p>
    {/each}
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
  }
  .title-row .spacer,
  .snapshot-head .spacer {
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
  h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .meta {
    margin: 0.25rem 0 1rem;
    font-size: 0.85rem;
  }
  .rename {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    flex: 1;
  }
  .rename input {
    flex: 1 1 16rem;
    max-width: 28rem;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .form .error {
    margin: 0;
  }
  .date {
    max-width: 12rem;
  }
  .hint {
    margin: 0;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .snapshot {
    border-bottom: 1px solid var(--border);
  }
  .snapshot:last-child {
    border-bottom: none;
  }
  .snapshot-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem 0.75rem;
    padding: 0.6rem 1rem;
  }
  .date-toggle {
    display: inline-flex;
    gap: 0.35rem;
    font-weight: 600;
    color: var(--text);
  }
  .caret {
    width: 0.75em;
    color: var(--muted);
  }
  .added {
    font-size: 0.85rem;
  }
  table.holdings {
    width: auto;
    min-width: 18rem;
    margin: 0 1rem 0.75rem 2.1rem;
  }
  table.holdings th,
  table.holdings td {
    padding: 0.25rem 1.5rem 0.25rem 0;
  }

  @media (max-width: 720px) {
    .date {
      max-width: none;
    }
    .actions button {
      flex: 1;
    }
    .snapshot-head .spacer {
      flex-basis: 100%;
      height: 0;
    }
    table.holdings {
      min-width: 0;
      width: calc(100% - 2rem);
      margin: 0 1rem 0.75rem;
    }
  }
</style>
