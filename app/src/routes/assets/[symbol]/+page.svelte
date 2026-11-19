<script lang="ts">
  import { formatDateTime } from "#lib/format.ts";
  import { href } from "#lib/router.svelte.ts";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const asset = $derived(data.asset);
</script>

<svelte:head>
  <title>{asset.symbol} · Data service</title>
</svelte:head>

<p><a href={href("assets")}>← Assets</a></p>
<h1><span class="mono">{asset.symbol}</span></h1>

<dl class="card facts">
  <dt>Provider</dt>
  <dd class="mono">{asset.provider}</dd>
  <dt>Backfill start</dt>
  <dd class="mono">{asset.backfillStartDate}</dd>
  <dt>Enabled</dt>
  <dd>{asset.enabled ? "On" : "Paused"}</dd>
  <dt>Created</dt>
  <dd>{formatDateTime(asset.createdAt)}</dd>
  <dt>Updated</dt>
  <dd>{formatDateTime(asset.updatedAt)}</dd>
</dl>

<h2>Workflows</h2>
<div class="card">
  <table class="stack">
    <thead>
      <tr>
        <th>Workflow</th>
        <th>Assignment</th>
      </tr>
    </thead>
    <tbody>
      {#each data.assignments as assignment (assignment.workflowId)}
        <tr class:disabled={!assignment.enabled}>
          <td
            ><a href={href("workflows", { id: assignment.workflowId })}
              >{assignment.workflowName}</a
            ></td
          >
          <td data-label="Assignment"
            >{assignment.enabled ? "Enabled" : "Disabled"}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.assignments.length === 0}
    <p class="notice">No workflows are assigned to this asset.</p>
  {/if}
</div>

<style>
  h1 {
    margin: 0.5rem 0 1rem;
  }
  h2 {
    font-size: 1rem;
    margin: 1.5rem 0 0.5rem;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.4rem 1.5rem;
    padding: 1rem;
    margin: 0;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  tr.disabled td {
    color: var(--muted);
  }
</style>
