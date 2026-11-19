<script lang="ts">
  import { goto } from "$app/navigation";

  import PortfolioDetail from "#lib/PortfolioDetail.svelte";
  import { href } from "#lib/router.svelte.ts";
  import WorkflowAssignmentsTable from "#lib/WorkflowAssignmentsTable.svelte";

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
{/if}

<style>
  h2 {
    font-size: 1rem;
    margin: 1.5rem 0 0.5rem;
  }
</style>
