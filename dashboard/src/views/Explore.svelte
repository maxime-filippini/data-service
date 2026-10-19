<script lang="ts">
  import {
    createPaginatedRowModel,
    createSortedRowModel,
    createTable,
    rowPaginationFeature,
    rowSortingFeature,
    sortFn_alphanumeric,
    sortFn_basic,
    tableFeatures,
    type ColumnDef,
  } from "@tanstack/svelte-table";
  import { untrack } from "svelte";

  import { datasetUrl, fetchDatasetFile, fetchSymbols, type SymbolStatusView } from "../lib/api";
  import { formatBytes, formatCount, formatRange, formatValue } from "../lib/format";
  import { readParquet, type Column, type Dataset, type Row } from "../lib/parquet";
  import { replace, route } from "../lib/router.svelte";

  const PAGE_SIZES = [25, 50, 100, 250];

  const features = tableFeatures({
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
    rowPaginationFeature,
    paginatedRowModel: createPaginatedRowModel(),
  });

  const dataset = $derived(route.params.get("dataset") ?? "");
  const symbol = $derived(route.params.get("symbol") ?? "");

  let symbols = $state<SymbolStatusView[]>([]);
  let file = $state<Dataset | null>(null);
  let fileSize = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let from = $state("");
  let to = $state("");

  // Only symbols with a successful download can have a Parquet file.
  const choices = $derived(symbols.filter((s) => s.lastCompletedRun !== null));

  fetchSymbols({})
    .then((result) => (symbols = result.symbols))
    .catch((cause) => (error = cause instanceof Error ? cause.message : String(cause)));

  let latestRequest = 0;

  const load = async () => {
    const request = ++latestRequest;
    file = null;
    error = null;
    if (!dataset || !symbol) return;
    loading = true;
    try {
      const bytes = await fetchDatasetFile(dataset, symbol);
      const decoded = await readParquet(bytes);
      if (request !== latestRequest) return;
      fileSize = bytes.byteLength;
      file = decoded;
      const dateColumn = decoded.columns.find((column) => column.kind === "date");
      table.setSorting(dateColumn ? [{ id: dateColumn.name, desc: true }] : []);
      table.resetPageIndex(true);
    } catch (cause) {
      if (request === latestRequest) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (request === latestRequest) loading = false;
    }
  };

  $effect(() => {
    void dataset;
    void symbol;
    untrack(() => load());
  });

  const columns = $derived(file?.columns ?? []);
  const kinds = $derived(new Map(columns.map((column) => [column.name, column.kind])));

  // The date range applies to the first date column, e.g. `date` in prices_eod.
  const dateColumn = $derived(columns.find((column) => column.kind === "date")?.name);
  const rows = $derived.by(() => {
    const all = file?.rows ?? [];
    if (dateColumn === undefined || (from === "" && to === "")) return all;
    return all.filter((row) => {
      const value = row[dateColumn];
      if (typeof value !== "string") return false;
      const day = value.slice(0, 10);
      return (from === "" || day >= from) && (to === "" || day <= to);
    });
  });

  const span = $derived.by(() => {
    if (dateColumn === undefined || !file || file.rows.length === 0) return null;
    const days = file.rows.map((row) => String(row[dateColumn]).slice(0, 10)).sort();
    return { first: days[0]!, last: days.at(-1)! };
  });

  const toColumnDef = (column: Column): ColumnDef<typeof features, Row> => ({
    id: column.name,
    accessorFn: (row) => row[column.name],
    header: column.name,
    sortFn: column.kind === "number" ? "basic" : "alphanumeric",
    sortUndefined: "last",
    sortDescFirst: column.kind !== "text",
  });

  const table = createTable({
    features,
    get columns() {
      return columns.map(toColumnDef);
    },
    get data() {
      return rows;
    },
    initialState: { pagination: { pageIndex: 0, pageSize: 50 }, sorting: [] },
  });

  const pagination = $derived(table.atoms.pagination.get());

  const choose = (value: string) => {
    const [nextDataset = "", nextSymbol = ""] = value.split("/");
    from = "";
    to = "";
    replace("explore", { dataset: nextDataset, symbol: nextSymbol });
  };

  const sortMark = (direction: false | "asc" | "desc") =>
    direction === "asc" ? "▲" : direction === "desc" ? "▼" : "";
</script>

<div class="toolbar">
  <select
    aria-label="Symbol"
    value={dataset && symbol ? `${dataset}/${symbol}` : ""}
    onchange={(event) => choose(event.currentTarget.value)}
  >
    <option value="" disabled>Choose a symbol</option>
    {#if dataset && symbol && !choices.some((s) => s.dataset === dataset && s.symbol === symbol)}
      <option value={`${dataset}/${symbol}`}>{symbol} · {dataset}</option>
    {/if}
    {#each choices as s (`${s.dataset}/${s.symbol}`)}
      <option value={`${s.dataset}/${s.symbol}`}>{s.symbol} · {s.dataset}</option>
    {/each}
  </select>
  {#if dateColumn !== undefined}
    <label class="muted">
      From <input type="date" bind:value={from} min={span?.first} max={span?.last} />
    </label>
    <label class="muted">
      To <input type="date" bind:value={to} min={span?.first} max={span?.last} />
    </label>
    {#if from || to}
      <button onclick={() => ((from = ""), (to = ""))}>Clear dates</button>
    {/if}
  {/if}
  <span class="spacer"></span>
  {#if file}
    <a href={datasetUrl(dataset, symbol)} download={`${symbol}.${dataset}.parquet`}>Download Parquet</a>
  {/if}
  <button onclick={() => load()} disabled={loading || !symbol}>Refresh</button>
</div>

{#if error}
  <div class="error">{error}</div>
{/if}

{#if file}
  <p class="summary muted">
    {formatCount(file.rows.length)} rows · {columns.length} columns · {formatBytes(fileSize)}
    {#if span}· {formatRange(span.first, span.last)}{/if}
    {#if rows.length !== file.rows.length}· <strong>{formatCount(rows.length)} in range</strong>{/if}
  </p>
{/if}

<div class="card">
  {#if file}
    <table>
      <thead>
        {#each table.getHeaderGroups() as group (group.id)}
          <tr>
            {#each group.headers as header (header.id)}
              <th class:num={kinds.get(header.column.id) === "number"}>
                <button class="sort" onclick={header.column.getToggleSortingHandler()}>
                  {header.column.id}
                  <span class="mark">{sortMark(header.column.getIsSorted())}</span>
                </button>
              </th>
            {/each}
          </tr>
        {/each}
      </thead>
      <tbody>
        {#each table.getRowModel().rows as row (row.id)}
          <tr>
            {#each row.getAllCells() as cell (cell.id)}
              {@const kind = kinds.get(cell.column.id)}
              <td class:num={kind === "number"} class:mono={kind === "date"}>
                {formatValue(cell.getValue() as Row[string])}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length === 0}
      <p class="notice">No rows in this date range.</p>
    {/if}
  {:else if loading}
    <p class="notice">Loading…</p>
  {:else if !symbol}
    <p class="notice">Choose a symbol to see its data.</p>
  {/if}
</div>

{#if file && rows.length > 0}
  <div class="pager">
    <button onclick={() => table.firstPage()} disabled={!table.getCanPreviousPage()}>« First</button>
    <button onclick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>‹ Previous</button>
    <span class="muted">Page {pagination.pageIndex + 1} of {table.getPageCount()}</span>
    <button onclick={() => table.nextPage()} disabled={!table.getCanNextPage()}>Next ›</button>
    <button onclick={() => table.lastPage()} disabled={!table.getCanNextPage()}>Last »</button>
    <select
      aria-label="Rows per page"
      value={pagination.pageSize}
      onchange={(event) => table.setPageSize(Number(event.currentTarget.value))}
    >
      {#each PAGE_SIZES as size (size)}
        <option value={size}>{size} per page</option>
      {/each}
    </select>
  </div>
{/if}

<style>
  .summary {
    margin: -0.25rem 0 0.75rem;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  th .sort {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    gap: 0.25rem;
  }
  th.num .sort {
    flex-direction: row-reverse;
  }
  th .sort:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  th .mark {
    display: inline-block;
    min-width: 0.75em;
    color: var(--accent);
  }
  tbody tr:hover td {
    background: var(--row-hover);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
</style>
