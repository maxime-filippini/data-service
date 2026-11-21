<script lang="ts">
  import { href } from "#lib/router.svelte.ts";
  import { formatHourUtc } from "#lib/subjects.ts";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const defaultIds = $derived(
    new Set(data.defaults.map((entry) => entry.workflowId)),
  );
</script>

<svelte:head>
  <title>Workflows · Data service</title>
</svelte:head>

<p class="muted intro">
  Workflow definitions: ordered steps run once a day for each assigned subject.
  Submit and replace whole specifications through the API. Defaults are assigned
  to each new asset or portfolio when it is created.
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
        <th>Default</th>
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
          <td data-label="Default"
            >{defaultIds.has(workflow.id)
              ? `For new ${workflow.scope}s`
              : "—"}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.workflows.length === 0}
    <p class="notice">No workflow definitions yet.</p>
  {/if}
</div>

<h2>Defaults for new subjects</h2>
<div class="card">
  <table class="stack">
    <thead>
      <tr>
        <th>Subject kind</th>
        <th>Workflow</th>
        <th>Schedule</th>
      </tr>
    </thead>
    <tbody>
      {#each data.defaults as entry (`${entry.subjectKind}/${entry.workflowId}`)}
        <tr class:disabled={!entry.workflowEnabled}>
          <td>{entry.subjectKind}</td>
          <td data-label="Workflow"
            ><a href={href("workflows", { id: entry.workflowId })}
              >{entry.workflowName}</a
            ></td
          >
          <td data-label="Schedule" class="mono"
            >{formatHourUtc(entry.schedule.hourUtc)}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.defaults.length === 0}
    <p class="notice">
      No defaults: new subjects get no workflows until assigned. Manage them
      with <span class="mono"
        >PUT /api/workflow-defaults/&lt;kind&gt;/&lt;id&gt;</span
      >.
    </p>
  {/if}
</div>

<style>
  h2 {
    font-size: 1rem;
    margin: 1.5rem 0 0.5rem;
  }
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
