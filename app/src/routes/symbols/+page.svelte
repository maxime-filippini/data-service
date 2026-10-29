<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";

  import { fetchSymbols, type RegisterInput, requestDownloads, setOnSchedule, type SymbolStatusView } from "#lib/api.ts";
  import { formatAgo, formatCount, formatDateTime } from "#lib/format.ts";
  import { href, replace, route } from "#lib/router.svelte.ts";
  import ScheduleCard from "#lib/ScheduleCard.svelte";
  import StatusBadge from "#lib/StatusBadge.svelte";
  import SymbolForm from "#lib/SymbolForm.svelte";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const enabled = $derived((route.params.get("enabled") ?? "") as "true" | "false" | "");

  // Loaded on the server, then reloaded here after each change.
  let symbols = $derived<readonly SymbolStatusView[]>(data.symbols);
  const options = $derived(data.options);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let search = $state("");
  /** The form being shown: a new symbol, or the symbol being edited. */
  let form = $state<{ initial?: RegisterInput } | null>(null);
  /** Rows with a request in flight. */
  const pending = new SvelteSet<string>();
  const selected = new SvelteSet<string>();

  const keyOf = (s: { dataset: string; symbol: string }) => `${s.dataset}/${s.symbol}`;
  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  let latestRequest = 0;

  // The registry is small, so load all of it and filter here. The schedule
  // card needs the full count either way.
  const load = async () => {
    const request = ++latestRequest;
    loading = true;
    try {
      const result = await fetchSymbols({});
      if (request !== latestRequest) return;
      symbols = result.symbols;
      for (const key of selected) if (!symbols.some((s) => keyOf(s) === key)) selected.delete(key);
    } catch (cause) {
      if (request === latestRequest) error = describe(cause);
    } finally {
      if (request === latestRequest) loading = false;
    }
  };

  const visible = $derived(
    symbols.filter(
      (s) =>
        (enabled === "" || s.enabled === (enabled === "true")) &&
        (search.trim() === "" || s.symbol.includes(search.trim().toUpperCase())),
    ),
  );

  const counts = $derived({
    total: symbols.length,
    scheduled: symbols.filter((s) => s.enabled).length,
    runFailed: symbols.filter((s) => s.latestRun?.status === "failed").length,
    jobFailed: symbols.filter((s) => s.latestJob?.status === "failed").length,
    neverIngested: symbols.filter((s) => s.lastCompletedRun === null).length,
  });

  const allVisibleSelected = $derived(visible.length > 0 && visible.every((s) => selected.has(keyOf(s))));

  const toggleAll = () => {
    if (allVisibleSelected) for (const s of visible) selected.delete(keyOf(s));
    else for (const s of visible) selected.add(keyOf(s));
  };

  const toggleSelected = (key: string) => (selected.has(key) ? selected.delete(key) : selected.add(key));

  const toggleSchedule = async (s: SymbolStatusView) => {
    const key = keyOf(s);
    pending.add(key);
    error = null;
    message = null;
    try {
      await setOnSchedule(s.dataset, s.symbol, !s.enabled);
      await load();
    } catch (cause) {
      error = describe(cause);
    } finally {
      pending.delete(key);
    }
  };

  const download = async (entries: { dataset: string; symbol: string }[]) => {
    const keys = entries.map(keyOf);
    for (const key of keys) pending.add(key);
    error = null;
    message = null;
    try {
      const { queued } = await requestDownloads(entries);
      message = `Queued ${queued.length} download${queued.length === 1 ? "" : "s"}. Follow them under Ingestion runs.`;
      for (const key of keys) selected.delete(key);
    } catch (cause) {
      error = describe(cause);
    } finally {
      for (const key of keys) pending.delete(key);
    }
  };

  const downloadSelected = () =>
    download(symbols.filter((s) => selected.has(keyOf(s))).map(({ dataset, symbol }) => ({ dataset, symbol })));

  const edit = (s: SymbolStatusView) => {
    message = null;
    form = {
      initial: {
        dataset: s.dataset,
        symbol: s.symbol,
        provider: s.provider,
        backfillStartDate: s.backfillStartDate,
        enabled: s.enabled,
      },
    };
  };

  const saved = async (savedSymbols: string[], done: boolean) => {
    const adding = form?.initial === undefined;
    if (done) form = null;
    message =
      savedSymbols.length === 0
        ? null
        : adding
          ? `Added ${savedSymbols.length === 1 ? savedSymbols[0] : `${savedSymbols.length} symbols: ${savedSymbols.join(", ")}`}.`
          : `Saved ${savedSymbols[0]}.`;
    await load();
  };
</script>

<ScheduleCard
  schedule={data.schedule}
  runs={data.scheduleRuns}
  scheduledCount={counts.scheduled}
  onnotify={(outcome) => {
    error = outcome && "error" in outcome ? outcome.error : null;
    message = outcome && "message" in outcome ? outcome.message : null;
  }}
/>

<div class="toolbar">
  <input placeholder="Search symbols" bind:value={search} aria-label="Search symbols" />
  <select
    aria-label="Schedule filter"
    value={enabled}
    onchange={(event) => replace("symbols", { enabled: event.currentTarget.value })}
  >
    <option value="">All symbols</option>
    <option value="true">On the schedule</option>
    <option value="false">Off the schedule</option>
  </select>
  <span class="spacer"></span>
  {#if selected.size > 0}
    <button class="primary" onclick={downloadSelected}>Download {selected.size} now</button>
    <button onclick={() => selected.clear()}>Clear selection</button>
  {/if}
  <button onclick={() => ((form = {}), (message = null), (error = null))} disabled={form !== null}>
    Add symbols
  </button>
  <button onclick={() => load()} disabled={loading}>Refresh</button>
</div>

{#if form}
  {#key form}
    <SymbolForm
      {options}
      initial={form.initial}
      existing={new Set(symbols.map(keyOf))}
      onsaved={saved}
      oncancel={() => (form = null)}
    />
  {/key}
{/if}

{#if error}
  <div class="error">{error}</div>
{/if}
{#if message}
  <div class="success">{message}</div>
{/if}

{#if symbols.length > 0}
  <p class="summary muted">
    {counts.total} symbol{counts.total === 1 ? "" : "s"}, {counts.scheduled} on the schedule
    {#if counts.runFailed > 0}· <span class="bad">{counts.runFailed} with a failed latest download</span>{/if}
    {#if counts.jobFailed > 0}· <span class="bad">{counts.jobFailed} with a failed latest rebuild</span>{/if}
    {#if counts.neverIngested > 0}· {counts.neverIngested} never downloaded{/if}
  </p>
{/if}

<div class="card">
  {#if visible.length > 0}
    <!-- The table header, with its select-all box, is hidden on phones. -->
    <label class="select-all">
      <input type="checkbox" checked={allVisibleSelected} onchange={toggleAll} />
      Select all {visible.length} shown
    </label>
  {/if}
  <table class="stack">
    <thead>
      <tr>
        <th class="pick">
          <input
            type="checkbox"
            aria-label="Select all shown"
            checked={allVisibleSelected}
            onchange={toggleAll}
            disabled={visible.length === 0}
          />
        </th>
        <th>Symbol</th>
        <th>Dataset</th>
        <th>Provider</th>
        <th>On schedule</th>
        <th>History from</th>
        <th>Latest download</th>
        <th>Last successful download</th>
        <th class="num">Rows</th>
        <th>Data through</th>
        <th>Latest rebuild</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each visible as s (keyOf(s))}
        {@const key = keyOf(s)}
        <tr class="entry" class:disabled={!s.enabled} class:picked={selected.has(key)}>
          <td class="pick">
            <input
              type="checkbox"
              aria-label={`Select ${s.symbol}`}
              checked={selected.has(key)}
              onchange={() => toggleSelected(key)}
            />
          </td>
          <td class="symbol">
            <a href={href("runs", { symbol: s.symbol })} title="Show runs">{s.symbol}</a>
          </td>
          <td data-label="Dataset">{s.dataset}</td>
          <td class="wide-only">{s.provider}</td>
          <td class="schedule">
            <label class="switch" title={s.enabled ? "Take off the daily schedule" : "Put on the daily schedule"}>
              <input
                type="checkbox"
                role="switch"
                aria-label={`${s.symbol} on the daily schedule`}
                checked={s.enabled}
                disabled={pending.has(key)}
                onchange={() => toggleSchedule(s)}
              />
              <span>{s.enabled ? "On" : "Off"}</span>
            </label>
          </td>
          <td class="mono wide-only">{s.backfillStartDate}</td>
          <td data-label="Latest download">
            {#if s.latestRun}
              <StatusBadge status={s.latestRun.status} title={s.latestRun.error ?? undefined} />
              <span class="muted ago" title={formatDateTime(s.latestRun.createdAt)}>
                {formatAgo(s.latestRun.createdAt)}
              </span>
            {:else}
              <span class="muted">Never</span>
            {/if}
          </td>
          <td data-label="Last successful">
            {#if s.lastCompletedRun}
              <span title={formatDateTime(s.lastCompletedRun.completedAt)}>
                {formatAgo(s.lastCompletedRun.completedAt)}
              </span>
            {:else}
              <span class="muted">—</span>
            {/if}
          </td>
          <td data-label="Rows" class="num">
            {s.lastCompletedRun ? formatCount(s.lastCompletedRun.rowCount) : "—"}
          </td>
          <td data-label="Data through" class="mono">{s.lastCompletedRun?.observedTo ?? "—"}</td>
          <td data-label="Latest rebuild">
            {#if s.latestJob}
              <StatusBadge status={s.latestJob.status} title={s.latestJob.error ?? undefined} />
              <span class="muted ago" title={formatDateTime(s.latestJob.completedAt ?? s.latestJob.createdAt)}>
                {formatAgo(s.latestJob.completedAt ?? s.latestJob.createdAt)}
              </span>
            {:else}
              <span class="muted">—</span>
            {/if}
          </td>
          <td class="full">
            <div class="actions">
              <button class="link" onclick={() => edit(s)}>Edit</button>
              <button
                class="link"
                onclick={() => download([{ dataset: s.dataset, symbol: s.symbol }])}
                disabled={pending.has(key)}
              >
                Download
              </button>
              {#if s.lastCompletedRun}
                <a href={href("explore", { dataset: s.dataset, symbol: s.symbol })}>Explore</a>
              {/if}
            </div>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if visible.length === 0 && !loading && !error}
    <p class="notice">
      {symbols.length === 0 ? "No symbols are registered. Add one to get started." : "No symbols match your filters."}
    </p>
  {:else if loading && symbols.length === 0}
    <p class="notice">Loading…</p>
  {/if}
</div>

<style>
  .summary {
    margin: -0.25rem 0 0.75rem;
  }
  .select-all {
    display: none;
  }
  .bad {
    color: var(--bad-fg);
  }
  tr.disabled td {
    color: var(--muted);
  }
  tr.picked td {
    background: var(--row-hover);
  }
  .pick {
    width: 1%;
    padding-right: 0;
  }
  .ago {
    white-space: nowrap;
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
  }
  .actions {
    display: flex;
    gap: 0.75rem;
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
  button.link:disabled {
    color: var(--muted);
    cursor: default;
  }

  /* Phones: each symbol is a card with the checkbox, symbol and schedule
     switch on top, then its latest activity. */
  @media (max-width: 720px) {
    .select-all {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 1rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.85rem;
    }
    tr.entry {
      grid-template-columns: auto repeat(2, minmax(0, 1fr));
      grid-auto-flow: row dense;
      column-gap: 0.75rem;
    }
    tr.entry.picked {
      background: var(--row-hover);
    }
    tr.picked td {
      background: none;
    }
    .pick {
      grid-column: 1;
      grid-row: 1 / span 5;
      width: auto;
    }
    .symbol {
      grid-column: 2;
      grid-row: 1;
      font-weight: 600;
    }
    .schedule {
      grid-column: 3;
      grid-row: 1;
      justify-self: end;
    }
    tr.entry td.full {
      grid-column: 2 / span 2;
    }
    .actions {
      gap: 0.5rem;
    }
    .actions > button.link,
    .actions > a {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 2.25rem;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
  }
</style>
