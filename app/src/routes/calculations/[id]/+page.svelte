<script lang="ts">
  import { goto } from "$app/navigation";

  import CalculationDetail from "#lib/CalculationDetail.svelte";
  import { calculationTypes } from "#lib/calculation-types.svelte.ts";
  import { href } from "#lib/router.svelte.ts";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  $effect(() => void calculationTypes.load());
</script>

<svelte:head>
  <title>{data.calculation.name} · Data service</title>
</svelte:head>

{#if calculationTypes.error}
  <div class="error">{calculationTypes.error}</div>
{/if}

{#key data.calculation.id}
  <CalculationDetail
    calculation={data.calculation}
    runs={data.runs}
    types={calculationTypes.list}
    portfolios={data.portfolios}
    ondeleted={(name) =>
      goto(href("calculations"), { state: { message: `Deleted ${name}. Its results stay in R2.` } })}
  />
{/key}
