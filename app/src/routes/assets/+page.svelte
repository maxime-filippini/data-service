<script lang="ts">
  import { formatDateTime } from "#lib/format.ts";
  import { href } from "#lib/router.svelte.ts";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Assets · Data service</title>
</svelte:head>

<p class="muted intro">
  Instruments identified by symbol. Workflows are assigned to them; change them
  through the API.
</p>

<div class="card">
  <table class="stack">
    <thead>
      <tr>
        <th>Symbol</th>
        <th>Provider</th>
        <th>Backfill start</th>
        <th>Enabled</th>
        <th>Updated</th>
      </tr>
    </thead>
    <tbody>
      {#each data.assets as asset (asset.symbol)}
        <tr class:disabled={!asset.enabled}>
          <td class="mono name"
            ><a href={href("assets", { id: asset.symbol })}>{asset.symbol}</a
            ></td
          >
          <td data-label="Provider" class="mono">{asset.provider}</td>
          <td data-label="Backfill start" class="mono"
            >{asset.backfillStartDate}</td
          >
          <td data-label="Enabled">{asset.enabled ? "On" : "Paused"}</td>
          <td data-label="Updated" class="muted"
            >{formatDateTime(asset.updatedAt)}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.assets.length === 0}
    <p class="notice">No assets yet.</p>
  {/if}
</div>

<style>
  .intro {
    margin-top: 0;
  }
  .name {
    font-weight: 600;
  }
  tr.disabled td {
    color: var(--muted);
  }
</style>
