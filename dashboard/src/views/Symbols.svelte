<script lang="ts">
  import { untrack } from "svelte";

  import { fetchSymbols, type SymbolStatusView } from "../lib/api";
  import { formatAgo, formatCount, formatDateTime } from "../lib/format";
  import { href, replace, route } from "../lib/router.svelte";
  import StatusBadge from "../lib/StatusBadge.svelte";

  const enabled = $derived((route.params.get("enabled") ?? "") as "true" | "false" | "");

  let symbols = $state<SymbolStatusView[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let search = $state("");

  let latestRequest = 0;

  const load = async () => {
    const request = ++latestRequest;
    loading = true;
    error = null;
    try {
      const result = await fetchSymbols({ enabled: enabled || undefined });
      if (request === latestRequest) symbols = result.symbols;
    } catch (cause) {
      if (request === latestRequest) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (request === latestRequest) loading = false;
    }
  };

  $effect(() => {
    void enabled;
    untrack(() => load());
  });

  const visible = $derived(
    search.trim() === ""
      ? symbols
      : symbols.filter((s) => s.symbol.includes(search.trim().toUpperCase())),
  );

  const counts = $derived({
    total: symbols.length,
    runFailed: symbols.filter((s) => s.latestRun?.status === "failed").length,
    jobFailed: symbols.filter((s) => s.latestJob?.status === "failed").length,
    neverIngested: symbols.filter((s) => s.lastCompletedRun === null).length,
  });
</script>

<div class="toolbar">
  <input placeholder="Search symbols" bind:value={search} aria-label="Search symbols" />
  <select
    aria-label="Enabled"
    value={enabled}
    onchange={(event) => replace("symbols", { enabled: event.currentTarget.value })}
  >
    <option value="">Enabled and disabled</option>
    <option value="true">Enabled only</option>
    <option value="false">Disabled only</option>
  </select>
  <span class="spacer"></span>
  <button onclick={() => load()} disabled={loading}>Refresh</button>
</div>

{#if error}
  <div class="error">{error}</div>
{/if}

{#if symbols.length > 0}
  <p class="summary muted">
    {counts.total} symbol{counts.total === 1 ? "" : "s"}
    {#if counts.runFailed > 0}· <span class="bad">{counts.runFailed} with a failed latest download</span>{/if}
    {#if counts.jobFailed > 0}· <span class="bad">{counts.jobFailed} with a failed latest rebuild</span>{/if}
    {#if counts.neverIngested > 0}· {counts.neverIngested} never downloaded{/if}
  </p>
{/if}

<div class="card">
  <table>
    <thead>
      <tr>
        <th>Symbol</th>
        <th>Dataset</th>
        <th>Provider</th>
        <th>Enabled</th>
        <th>History from</th>
        <th>Latest download</th>
        <th>Last successful download</th>
        <th class="num">Rows</th>
        <th>Data through</th>
        <th>Latest rebuild</th>
      </tr>
    </thead>
    <tbody>
      {#each visible as s (`${s.dataset}/${s.symbol}`)}
        <tr class:disabled={!s.enabled}>
          <td>
            <a href={href("runs", { symbol: s.symbol })} title="Show runs">{s.symbol}</a>
          </td>
          <td>{s.dataset}</td>
          <td>{s.provider}</td>
          <td>{s.enabled ? "Yes" : "No"}</td>
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
        </tr>
      {/each}
    </tbody>
  </table>

  {#if visible.length === 0 && !loading && !error}
    <p class="notice">
      {symbols.length === 0 ? "No symbols are registered." : "No symbols match your search."}
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
</style>
