<script lang="ts">
  import { publicationDataUrl } from "#lib/api.ts";
  import { formatBytes, formatDateTime } from "#lib/format.ts";
  import { href } from "#lib/router.svelte.ts";
  import WorkflowAssignmentsTable from "#lib/WorkflowAssignmentsTable.svelte";
  import WorkflowRunsTable from "#lib/WorkflowRunsTable.svelte";

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
<WorkflowAssignmentsTable assignments={data.assignments} />

<h2 id="datasets">Published datasets</h2>
<div class="card">
  <table class="stack">
    <thead>
      <tr>
        <th>Dataset</th>
        <th>Processing date</th>
        <th>Published by</th>
        <th>Published</th>
        <th>Data</th>
      </tr>
    </thead>
    <tbody>
      {#each data.publications as publication (publication.dataset)}
        <tr>
          <td class="mono">{publication.dataset}</td>
          <td data-label="Processing date" class="mono"
            >{publication.processingDate}</td
          >
          <td data-label="Published by"
            ><a href={href("workflow-runs", { id: publication.producer.runId })}
              >{publication.producer.workflowName ?? "Run"}</a
            ></td
          >
          <td data-label="Published"
            >{formatDateTime(publication.publishedAt)}</td
          >
          <td data-label="Data">
            <a
              href={href("explore", {
                dataset: publication.dataset,
                kind: "asset",
                subject: asset.symbol,
              })}>Explore</a
            >
            ·
            <a
              href={publicationDataUrl(
                publication.dataset,
                publication.subject,
              )}>Parquet</a
            >
            <span class="muted">({formatBytes(publication.size)})</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.publications.length === 0}
    <p class="notice">
      No workflow has published a dataset for this asset yet.
    </p>
  {/if}
</div>

<h2>Recent runs</h2>
<WorkflowRunsTable runs={data.runs} showSubject={false} />
<p class="more">
  <a href={href("workflow-runs", { symbol: asset.symbol })}
    >All runs for {asset.symbol} →</a
  >
</p>

<style>
  .more {
    margin: 0.5rem 0 0;
  }
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
</style>
