<script lang="ts">
  import { navigating } from "$app/state";

  import { publicationDataUrl } from "#lib/api.ts";
  import {
    formatAgo,
    formatBytes,
    formatCount,
    formatDateTime,
  } from "#lib/format.ts";
  import { href } from "#lib/router.svelte.ts";
  import StatusBadge from "#lib/StatusBadge.svelte";
  import { formatHourUtc, subjectHref, subjectLabel } from "#lib/subjects.ts";

  import type { PageProps } from "./$types";

  const SECTIONS = [
    {
      path: "/assets",
      title: "Assets",
      text: "Registered instruments, their provider settings and assigned workflows.",
    },
    {
      path: "/portfolios",
      title: "Portfolios",
      text: "Dated holdings snapshots and portfolio workflow assignments.",
    },
    {
      path: "/workflows",
      title: "Workflows",
      text: "Workflow definitions, ordered steps, input connections and daily UTC schedules.",
    },
    {
      path: "/workflow-runs",
      title: "Runs",
      text: "Scheduled and manual workflow runs, step outcomes, waits and errors.",
    },
    {
      path: "/explore",
      title: "Explore data",
      text: "Browse published asset and portfolio Parquet datasets from R2.",
    },
  ];

  let { data }: PageProps = $props();

  const home = $derived(data.home);
</script>

<section class="intro">
  <h1>Data service</h1>
  <p class="muted">
    Runs daily asset and portfolio workflow definitions on Cloudflare Workflows
    and a single Python operation service, publishing Parquet datasets to R2 by
    dataset name and subject.
    <a href="/docs/" rel="external">Read the docs</a>.
  </p>
</section>

<section class="tiles" aria-label="Summary">
  <a class="tile card" href={href("assets")}>
    <span class="label">Assets</span>
    <span class="value">{formatCount(home.assets.total)}</span>
    <span class="muted">{formatCount(home.assets.enabled)} enabled</span>
  </a>
  <a class="tile card" href={href("portfolios")}>
    <span class="label">Portfolios</span>
    <span class="value">{formatCount(home.portfolioCount)}</span>
    <span class="muted">dated holdings</span>
  </a>
  <a class="tile card" href={href("workflows")}>
    <span class="label">Workflows</span>
    <span class="value">{formatCount(home.workflows.total)}</span>
    <span class="muted">{formatCount(home.workflows.enabled)} enabled</span>
  </a>
  <a class="tile card" href={href("explore")}>
    <span class="label">Published datasets</span>
    <span class="value">{formatCount(home.publications.total)}</span>
    <span class="muted">current in R2</span>
  </a>
</section>

<div class="columns">
  <section class="card panel">
    <div class="panel-head">
      <h2>Workflow definitions</h2>
      <a href={href("workflows")}>All workflows →</a>
    </div>
    {#if home.workflows.definitions.length === 0}
      <p class="muted">No workflow definitions yet.</p>
    {:else}
      <ul class="list">
        {#each home.workflows.definitions as workflow (workflow.id)}
          <li class:disabled={!workflow.enabled}>
            <a href={href("workflows", { id: workflow.id })}>{workflow.name}</a>
            <span class="muted">{workflow.scope}</span>
            <span class="muted mono"
              >{formatHourUtc(workflow.schedule.hourUtc)}</span
            >
            <span class="when muted">
              {workflow.stepCount} step{workflow.stepCount === 1 ? "" : "s"} ·
              {workflow.assignmentCount} assigned
              {#if !workflow.enabled}· paused{/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card panel">
    <div class="panel-head">
      <h2>Recent runs</h2>
      <a href={href("workflow-runs")}>All runs →</a>
    </div>
    {#if home.recentRuns.length === 0}
      <p class="muted">No workflow runs yet.</p>
    {:else}
      <ul class="list">
        {#each home.recentRuns as run (run.id)}
          <li>
            <StatusBadge status={run.status} title={run.error ?? undefined} />
            <a href={href("workflow-runs", { id: run.id })}
              >{run.workflowName}</a
            >
            <a class="mono" href={subjectHref(run.subject)}
              >{subjectLabel(run.subject)}</a
            >
            <span class="when muted">
              <span class="mono">{run.processingDate}</span> ·
              <span title={formatDateTime(run.createdAt)}
                >{formatAgo(run.createdAt)}</span
              >
            </span>
            {#if run.error}
              <span class="reason" title={run.error}>{run.error}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<section class="card panel publications">
  <div class="panel-head">
    <h2>Recent publications</h2>
    <a href={href("explore")}>Explore datasets →</a>
  </div>
  {#if home.publications.recent.length === 0}
    <p class="muted">No datasets have been published yet.</p>
  {:else}
    <ul class="list">
      {#each home.publications.recent as publication (`${publication.dataset}/${publication.subject.kind}/${subjectLabel(publication.subject)}`)}
        <li>
          <span class="mono">{publication.dataset}</span>
          <a class="mono" href={subjectHref(publication.subject)}
            >{subjectLabel(publication.subject)}</a
          >
          <span class="muted">
            for <span class="mono">{publication.processingDate}</span> ·
            {formatBytes(publication.size)}
          </span>
          <span class="when">
            <a
              href={href("explore", {
                dataset: publication.dataset,
                kind: publication.subject.kind,
                subject: subjectLabel(publication.subject),
              })}>Explore</a
            >
            ·
            <a
              href={publicationDataUrl(
                publication.dataset,
                publication.subject,
              )}>Parquet</a
            >
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section aria-label="Sections">
  <h2 class="sections-title">Go to</h2>
  <div class="sections">
    {#each SECTIONS as section (section.path)}
      <a class="card section" href={section.path}>
        <strong>{section.title}</strong>
        <span class="muted">{section.text}</span>
      </a>
    {/each}
    <a class="card section" href="/docs/" rel="external">
      <strong>Docs</strong>
      <span class="muted"
        >How workflows, operations, APIs and local fixtures work.</span
      >
    </a>
  </div>
</section>

{#if navigating.to}
  <p class="notice">Loading…</p>
{/if}

<style>
  .intro h1 {
    margin: 0 0 0.25rem;
    font-size: 1.5rem;
  }
  .intro p {
    margin: 0 0 1.25rem;
    max-width: 70ch;
    line-height: 1.5;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.9rem 1rem;
    color: var(--text);
    font-size: 0.85rem;
  }
  .tile:hover,
  .section:hover {
    text-decoration: none;
    border-color: var(--accent);
  }
  .tile .label {
    font-weight: 600;
    color: var(--muted);
  }
  .tile .value {
    font-size: 1.75rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .panel {
    padding: 1rem 1.25rem;
  }
  .publications {
    margin-bottom: 1.5rem;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .panel p {
    margin: 0.5rem 0 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.6rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--border);
  }
  .list li:last-child {
    border-bottom: none;
  }
  .list li.disabled a {
    color: var(--muted);
  }
  .reason {
    flex: 1 1 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--bad-fg);
  }
  .when {
    margin-left: auto;
  }
  .sections-title {
    margin-bottom: 0.75rem;
  }
  .sections {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
    gap: 0.75rem;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.9rem 1rem;
    color: var(--text);
    font-size: 0.9rem;
  }
</style>
