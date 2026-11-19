<script lang="ts">
  import type { WorkflowAssignment } from "../../../src/workflows/views";
  import { href } from "./router.svelte";
  import { formatHourUtc } from "./subjects";

  let { assignments }: { assignments: readonly WorkflowAssignment[] } =
    $props();
</script>

<div class="card">
  {#if assignments.length === 0}
    <p class="notice">No workflows are assigned.</p>
  {:else}
    <table class="stack">
      <thead>
        <tr>
          <th>Workflow</th>
          <th>Schedule</th>
          <th>Assignment</th>
        </tr>
      </thead>
      <tbody>
        {#each assignments as assignment (assignment.workflowId)}
          <tr class:disabled={!assignment.enabled}>
            <td>
              <a href={href("workflows", { id: assignment.workflowId })}>
                {assignment.workflowName}
              </a>
            </td>
            <td data-label="Schedule" class="mono">
              Daily at {formatHourUtc(assignment.schedule.hourUtc)}
              {#if !assignment.workflowEnabled}<span class="muted"
                  >(workflow paused)</span
                >{/if}
            </td>
            <td data-label="Assignment"
              >{assignment.enabled ? "Enabled" : "Disabled"}</td
            >
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  tr.disabled td {
    color: var(--muted);
  }
</style>
