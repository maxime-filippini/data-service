<script lang="ts">
  import type { CalculationRunStatus, JobStatus, RunStatus, ScheduleRunStatus } from "./api";

  let {
    status,
    title,
  }: {
    status: RunStatus | JobStatus | ScheduleRunStatus | CalculationRunStatus | null;
    title?: string | undefined;
  } = $props();
</script>

{#if status === null}
  <span class="muted">—</span>
{:else}
  <span class="badge {status}" {title}>{status}</span>
{/if}

<style>
  .badge {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
    background: var(--neutral-bg);
    color: var(--neutral-fg);
  }
  .completed {
    background: var(--ok-bg);
    color: var(--ok-fg);
  }
  .failed {
    background: var(--bad-bg);
    color: var(--bad-fg);
  }
  .partial {
    background: var(--warn-bg);
    color: var(--warn-fg);
  }
  .fetching,
  .processing,
  .running {
    background: var(--busy-bg);
    color: var(--busy-fg);
  }
  .muted {
    color: var(--muted);
  }
</style>
