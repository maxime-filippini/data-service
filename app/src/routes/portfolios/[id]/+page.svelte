<script lang="ts">
  import { goto } from "$app/navigation";

  import { publicationDataUrl } from "#lib/api.ts";
  import { formatBytes, formatDateTime } from "#lib/format.ts";
  import PortfolioDetail from "#lib/PortfolioDetail.svelte";
  import { href } from "#lib/router.svelte.ts";
  import WorkflowAssignmentsTable from "#lib/WorkflowAssignmentsTable.svelte";
  import WorkflowRunsTable from "#lib/WorkflowRunsTable.svelte";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.portfolio.name} · Data service</title>
</svelte:head>

{#key `${data.portfolio.id}:${data.manage}`}
  <PortfolioDetail
    portfolio={data.portfolio}
    manage={data.manage}
    symbols={data.symbols}
    ondeleted={(deleted) =>
      goto(href("portfolios"), { state: { message: `Deleted ${deleted}.` } })}
  />
{/key}

{#if !data.manage}
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
              ><a
                href={href("workflow-runs", { id: publication.producer.runId })}
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
                  kind: "portfolio",
                  subject: data.portfolio.id,
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
        No workflow has published a dataset for this portfolio yet.
      </p>
    {/if}
  </div>

  <h2>Recent runs</h2>
  <WorkflowRunsTable runs={data.runs} showSubject={false} />
{/if}

<style>
  h2 {
    font-size: 1rem;
    margin: 1.5rem 0 0.5rem;
  }
</style>
