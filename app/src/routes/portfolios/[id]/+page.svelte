<script lang="ts">
  import { goto } from "$app/navigation";

  import PortfolioDetail from "#lib/PortfolioDetail.svelte";
  import { href } from "#lib/router.svelte.ts";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.portfolio.name} · Data service</title>
</svelte:head>

{#key data.portfolio.id}
  <PortfolioDetail
    portfolio={data.portfolio}
    symbols={data.symbols}
    ondeleted={(deleted) => goto(href("portfolios"), { state: { message: `Deleted ${deleted}.` } })}
  />
{/key}
