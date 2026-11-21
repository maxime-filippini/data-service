<script lang="ts">
  import type { WorkflowRunSummary } from "./api";
  import { formatDateTime, formatDuration } from "./format";
  import { href } from "./router.svelte";
  import StatusBadge from "./StatusBadge.svelte";
  import { formatHourUtc, subjectHref, subjectLabel } from "./subjects";

  let {
    runs,
    showWorkflow = true,
    showSubject = true,
    empty = "No runs yet.",
  }: {
    runs: readonly WorkflowRunSummary[];
    showWorkflow?: boolean;
    showSubject?: boolean;
    empty?: string;
  } = $props();
</script>

<div class="card">
  <table class="stack">
    <thead>
      <tr>
        <th>Started</th>
        {#if showWorkflow}<th>Workflow</th>{/if}
        {#if showSubject}<th>Subject</th>{/if}
        <th>Processing date</th>
        <th>Trigger</th>
        <th>Status</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.id)}
        <tr>
          <td
            ><a href={href("workflow-runs", { id: run.id })}
              >{formatDateTime(run.createdAt)}</a
            ></td
          >
          {#if showWorkflow}
            <td data-label="Workflow"
              ><a href={href("workflows", { id: run.workflowId })}
                >{run.workflowName}</a
              ></td
            >
          {/if}
          {#if showSubject}
            <td data-label="Subject" class="mono"
              ><a href={subjectHref(run.subject)}>{subjectLabel(run.subject)}</a
              ></td
            >
          {/if}
          <td data-label="Processing date" class="mono">{run.processingDate}</td
          >
          <td data-label="Trigger"
            >{#if run.scheduledFor !== null}<span
                title={`Schedule occurrence ${run.scheduledFor}`}
                >scheduled <span class="mono"
                  >{formatHourUtc(
                    new Date(run.scheduledFor).getUTCHours(),
                  )}</span
                ></span
              >{:else}manual{/if}</td
          >
          <td data-label="Status"
            ><StatusBadge
              status={run.status}
              title={run.error ?? undefined}
            />{#if run.rerunOf !== null}<span class="muted">
                rerun</span
              >{/if}</td
          >
          <td data-label="Duration"
            >{run.startedAt !== null && run.finishedAt !== null
              ? formatDuration(run.startedAt, run.finishedAt)
              : "—"}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
  {#if runs.length === 0}
    <p class="notice">{empty}</p>
  {/if}
</div>
