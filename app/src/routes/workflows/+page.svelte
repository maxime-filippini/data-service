<script lang="ts">
  import { href } from "#lib/router.svelte.ts";
  import { formatHourUtc } from "#lib/subjects.ts";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Workflows · Data service</title>
</svelte:head>

<p class="muted intro">
  Workflow definitions: ordered steps run once a day for each assigned subject.
  Submit and replace whole specifications through the API.
</p>

<div class="card">
  <table class="stack">
    <thead>
      <tr>
        <th>Name</th>
        <th>Scope</th>
        <th>Schedule</th>
        <th class="num">Steps</th>
        <th class="num">Assignments</th>
        <th>Enabled</th>
      </tr>
    </thead>
    <tbody>
      {#each data.workflows as workflow (workflow.id)}
        <tr class:disabled={!workflow.enabled}>
          <td class="name"
            ><a href={href("workflows", { id: workflow.id })}>{workflow.name}</a
            ></td
          >
          <td data-label="Scope">{workflow.scope}</td>
          <td data-label="Schedule" class="mono"
            >{formatHourUtc(workflow.schedule.hourUtc)}</td
          >
          <td data-label="Steps" class="num">{workflow.stepCount}</td>
          <td data-label="Assignments" class="num"
            >{workflow.assignmentCount}</td
          >
          <td data-label="Enabled">{workflow.enabled ? "On" : "Paused"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.workflows.length === 0}
    <p class="notice">No workflow definitions yet.</p>
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
