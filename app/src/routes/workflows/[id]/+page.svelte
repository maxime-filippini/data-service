<script lang="ts">
  import { formatDateTime } from "#lib/format.ts";
  import { href } from "#lib/router.svelte.ts";
  import { formatHourUtc, subjectHref, subjectLabel } from "#lib/subjects.ts";
  import WorkflowSteps from "#lib/WorkflowSteps.svelte";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const workflow = $derived(data.inspection.workflow);
</script>

<svelte:head>
  <title>{workflow.name} · Data service</title>
</svelte:head>

<p><a href={href("workflows")}>← Workflows</a></p>
<h1>{workflow.name}</h1>

<dl class="card facts">
  <dt>Scope</dt>
  <dd>{workflow.scope}</dd>
  <dt>Schedule</dt>
  <dd class="mono">Daily at {formatHourUtc(workflow.schedule.hourUtc)}</dd>
  <dt>Enabled</dt>
  <dd>{workflow.enabled ? "On" : "Paused"}</dd>
  <dt>ID</dt>
  <dd class="mono">{workflow.id}</dd>
  <dt>Updated</dt>
  <dd>{formatDateTime(workflow.updatedAt)}</dd>
</dl>

<h2>Steps, in execution order</h2>
<WorkflowSteps steps={data.inspection.steps} />

<h2>Assignments</h2>
<div class="card">
  <table class="stack">
    <thead>
      <tr>
        <th>Subject</th>
        <th>Kind</th>
        <th>Assignment</th>
      </tr>
    </thead>
    <tbody>
      {#each data.assignments as assignment (`${assignment.subject.kind}/${subjectLabel(assignment.subject)}`)}
        <tr class:disabled={!assignment.enabled}>
          <td class="mono"
            ><a href={subjectHref(assignment.subject)}
              >{subjectLabel(assignment.subject)}</a
            ></td
          >
          <td data-label="Kind">{assignment.subject.kind}</td>
          <td data-label="Assignment"
            >{assignment.enabled ? "Enabled" : "Disabled"}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
  {#if data.assignments.length === 0}
    <p class="notice">Not assigned to any {workflow.scope}.</p>
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
    overflow-wrap: anywhere;
  }
  tr.disabled td {
    color: var(--muted);
  }
</style>
