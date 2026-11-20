<script lang="ts">
  import {
    apiUrl,
    publicationDataUrl,
    type StepOutcome,
    type SubjectView,
  } from "#lib/api.ts";
  import { formatDateTime, formatDuration } from "#lib/format.ts";
  import { href } from "#lib/router.svelte.ts";
  import StatusBadge from "#lib/StatusBadge.svelte";
  import { subjectHref, subjectLabel } from "#lib/subjects.ts";

  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const run = $derived(data.run);

  /** An output that references a stored artifact. */
  const isArtifact = (
    value: unknown,
  ): value is { id: string; format: string; schema: string } =>
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "format" in value &&
    "schema" in value;

  /** An output naming a published dataset (a publish step's output). */
  const isPublication = (
    value: unknown,
  ): value is {
    dataset: string;
    subject: SubjectView;
    processingDate: string;
  } =>
    typeof value === "object" &&
    value !== null &&
    "dataset" in value &&
    "subject" in value &&
    "processingDate" in value;

  /** Where the app shows a subject's published datasets. */
  const datasetsHref = (subject: SubjectView) =>
    subject.kind === "asset"
      ? `${href("assets", { id: subject.symbol })}#datasets`
      : href("portfolios", { id: subject.id });

  const outputs = (step: StepOutcome) => Object.entries(step.outputs ?? {});
</script>

<svelte:head>
  <title>Run of {run.workflowName} · Data service</title>
</svelte:head>

<p><a href={href("workflow-runs")}>← Workflow runs</a></p>
<h1>{run.workflowName}</h1>

<dl class="card facts">
  <dt>Status</dt>
  <dd><StatusBadge status={run.status} /></dd>
  {#if run.error !== null}
    <dt>Error</dt>
    <dd class="error">{run.error}</dd>
  {/if}
  <dt>Subject</dt>
  <dd class="mono">
    <a href={subjectHref(run.subject)}>{subjectLabel(run.subject)}</a>
  </dd>
  <dt>Processing date</dt>
  <dd class="mono">{run.processingDate}</dd>
  <dt>Workflow</dt>
  <dd>
    <a href={href("workflows", { id: run.workflowId })}>{run.workflowId}</a>
  </dd>
  <dt>Trigger</dt>
  <dd>
    {run.trigger}{#if run.rerunOf !== null}, rerun of
      <a class="mono" href={href("workflow-runs", { id: run.rerunOf })}
        >{run.rerunOf}</a
      >{/if}
  </dd>
  <dt>Created</dt>
  <dd>{formatDateTime(run.createdAt)}</dd>
  {#if run.startedAt !== null && run.finishedAt !== null}
    <dt>Duration</dt>
    <dd>{formatDuration(run.startedAt, run.finishedAt)}</dd>
  {/if}
  <dt>Run ID</dt>
  <dd class="mono">{run.id}</dd>
</dl>

<h2>Steps, in execution order</h2>
<p class="muted note">The steps as captured when the run started.</p>
<ol class="steps">
  {#each run.steps as step (step.id)}
    <li class="card step">
      <header>
        <span class="position">{step.position}</span>
        <span class="mono id">{step.id}</span>
        <span class="mono muted">{step.type}</span>
        <StatusBadge status={step.status} />
        {#if step.attempts > 1}
          <span class="muted">{step.attempts} attempts</span>
        {/if}
      </header>
      {#if step.error !== null}
        <p class="error">
          {step.status === "running" ? "Last attempt: " : ""}{step.error}
        </p>
      {/if}
      {#if outputs(step).length > 0}
        <dl class="outputs">
          {#each outputs(step) as [name, value] (name)}
            <dt class="mono">{name}</dt>
            <dd>
              {#if isArtifact(value)}
                <a
                  href={apiUrl(
                    `/workflow-runs/${run.id}/steps/${step.id}/artifacts/${name}`,
                  )}>{value.schema} ({value.format})</a
                >
                <span class="mono muted">{value.id}</span>
              {:else if isPublication(value)}
                Published
                <a href={datasetsHref(value.subject)}
                  ><span class="mono">{value.dataset}</span> for {subjectLabel(
                    value.subject,
                  )}</a
                >
                (processing date
                <span class="mono">{value.processingDate}</span>) ·
                <a href={publicationDataUrl(value.dataset, value.subject)}
                  >current data</a
                >
              {:else}
                <code>{JSON.stringify(value)}</code>
              {/if}
            </dd>
          {/each}
        </dl>
      {/if}
    </li>
  {/each}
</ol>

<style>
  h1 {
    margin: 0.5rem 0 1rem;
  }
  h2 {
    font-size: 1rem;
    margin: 1.5rem 0 0.25rem;
  }
  .note {
    margin: 0 0 0.75rem;
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
  .error {
    color: var(--bad-fg);
  }
  .steps {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.75rem;
  }
  .step {
    padding: 0.75rem 1rem;
  }
  .step header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  .position {
    font-weight: 700;
    color: var(--muted);
  }
  .id {
    font-weight: 600;
  }
  .step p {
    margin: 0.5rem 0 0;
  }
  .outputs {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0.5rem 0 0;
  }
  .outputs dd .muted {
    display: block;
    font-size: 0.8rem;
  }
</style>
