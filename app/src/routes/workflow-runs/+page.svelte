<script lang="ts">
  import type { WorkflowRunStatus } from "#lib/api.ts";
  import { replace, route } from "#lib/router.svelte.ts";
  import WorkflowRunsTable from "#lib/WorkflowRunsTable.svelte";

  import type { PageProps } from "./$types";

  const STATUSES: WorkflowRunStatus[] = [
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "skipped",
  ];

  let { data }: PageProps = $props();

  const symbol = $derived(route.params.get("symbol") ?? "");
  const status = $derived(route.params.get("status") ?? "");
  const trigger = $derived(route.params.get("trigger") ?? "");
  let symbolInput = $derived(symbol);

  const setFilter = (next: {
    symbol?: string;
    status?: string;
    trigger?: string;
  }) => replace("workflow-runs", { symbol, status, trigger, ...next });

  const applySymbol = (event: SubmitEvent) => {
    event.preventDefault();
    setFilter({ symbol: symbolInput.trim().toUpperCase() });
  };
</script>

<svelte:head>
  <title>Workflow runs · Data service</title>
</svelte:head>

<p class="muted intro">
  Runs of workflow definitions, newest first. Start a run with
  <span class="mono">POST /api/runs</span>, or let the hourly tick dispatch each
  assignment at its workflow's daily hour; each run executes its steps in its
  own Cloudflare Workflow. A skipped run never ran because the assignment's
  previous run was still active.
</p>

<div class="toolbar">
  <form onsubmit={applySymbol}>
    <input
      placeholder="Asset, e.g. AAPL.US"
      bind:value={symbolInput}
      aria-label="Asset symbol"
    />
  </form>
  <select
    aria-label="Status"
    value={status}
    onchange={(event) => setFilter({ status: event.currentTarget.value })}
  >
    <option value="">Any status</option>
    {#each STATUSES as option (option)}
      <option value={option}>{option}</option>
    {/each}
  </select>
  <select
    aria-label="Trigger"
    value={trigger}
    onchange={(event) => setFilter({ trigger: event.currentTarget.value })}
  >
    <option value="">Manual or scheduled</option>
    <option value="manual">manual</option>
    <option value="schedule">scheduled</option>
  </select>
</div>

<WorkflowRunsTable runs={data.runs} empty="No runs match." />

<style>
  .intro {
    margin-top: 0;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
</style>
