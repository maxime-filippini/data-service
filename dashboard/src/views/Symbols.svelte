<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";

  import {
    type DatasetProviders,
    fetchOptions,
    fetchSymbols,
    type RegisterInput,
    requestDownloads,
    setOnSchedule,
    type SymbolStatusView,
  } from "../lib/api";
  import { formatAgo, formatCount, formatDateTime } from "../lib/format";
  import { href, replace, route } from "../lib/router.svelte";
  import ScheduleCard from "../lib/ScheduleCard.svelte";
  import StatusBadge from "../lib/StatusBadge.svelte";
  import SymbolForm from "../lib/SymbolForm.svelte";

  const enabled = $derived((route.params.get("enabled") ?? "") as "true" | "false" | "");

  let symbols = $state<SymbolStatusView[]>([]);
  let options = $state<DatasetProviders>({});
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
  void load();
  fetchOptions()
    .then((result) => (options = result.datasetProviders))
    .catch((cause) => (error = describe(cause)));

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

  const saved = async (input: RegisterInput) => {
    const added = form?.initial === undefined;
    form = null;
    message = added ? `Added ${input.symbol}.` : `Saved ${input.symbol}.`;
    await load();
  };
</script>

<ScheduleCard
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
    <option value="">On and off the schedule</option>
    <option value="true">On the schedule</option>
    <option value="false">Off the schedule</option>
  </select>
  <span class="spacer"></span>
  {#if selected.size > 0}
    <button class="primary" onclick={downloadSelected}>Download {selected.size} now</button>
    <button onclick={() => selected.clear()}>Clear selection</button>
  {/if}
  <button onclick={() => ((form = {}), (message = null), (error = null))} disabled={form !== null}>
    Add symbol
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
  <table>
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
        <tr class:disabled={!s.enabled} class:picked={selected.has(key)}>
          <td class="pick">
            <input
              type="checkbox"
              aria-label={`Select ${s.symbol}`}
              checked={selected.has(key)}
              onchange={() => toggleSelected(key)}
            />
          </td>
          <td>
            <a href={href("runs", { symbol: s.symbol })} title="Show runs">{s.symbol}</a>
          </td>
          <td>{s.dataset}</td>
          <td>{s.provider}</td>
          <td>
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
          <td class="mono">{s.backfillStartDate}</td>
          <td>
            {#if s.latestRun}
              <StatusBadge status={s.latestRun.status} title={s.latestRun.error ?? undefined} />
              <span class="muted" title={formatDateTime(s.latestRun.createdAt)}>
                {formatAgo(s.latestRun.createdAt)}
              </span>
            {:else}
              <span class="muted">Never</span>
            {/if}
          </td>
          <td>
            {#if s.lastCompletedRun}
              <span title={formatDateTime(s.lastCompletedRun.completedAt)}>
                {formatAgo(s.lastCompletedRun.completedAt)}
              </span>
            {:else}
              <span class="muted">—</span>
            {/if}
          </td>
          <td class="num">{s.lastCompletedRun ? formatCount(s.lastCompletedRun.rowCount) : "—"}</td>
          <td class="mono">{s.lastCompletedRun?.observedTo ?? "—"}</td>
          <td>
            {#if s.latestJob}
              <StatusBadge status={s.latestJob.status} title={s.latestJob.error ?? undefined} />
              <span class="muted" title={formatDateTime(s.latestJob.completedAt ?? s.latestJob.createdAt)}>
                {formatAgo(s.latestJob.completedAt ?? s.latestJob.createdAt)}
              </span>
            {:else}
              <span class="muted">—</span>
            {/if}
          </td>
          <td>
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
    text-decoration: underline;
  }
  button.link:disabled {
    color: var(--muted);
    cursor: default;
  }
</style>
