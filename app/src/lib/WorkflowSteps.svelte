<script lang="ts">
  import type { InputSource, InspectedStep } from "./api";

  /** A definition's steps in execution order, with their connections. */
  let { steps }: { steps: readonly InspectedStep[] } = $props();

  const anchor = (stepId: string) => `step-${stepId}`;
  const json = (value: unknown) => JSON.stringify(value);
  const sourceTitle = (source: InputSource) =>
    source.kind === "literal" ? "Literal value" : source.ref;
</script>

<ol class="steps">
  {#each steps as step (step.position)}
    <li class="card step" id={anchor(step.id)}>
      <header>
        <span class="position">{step.position}</span>
        <strong class="mono">{step.id}</strong>
        <span class="type mono">{step.type}</span>
      </header>
      {#if step.description === null}
        <p class="error">This step type is no longer registered.</p>
      {:else}
        <p class="muted description">{step.description}</p>
      {/if}

      <div class="sections">
        <section>
          <h3>Parameters</h3>
          {#if Object.keys(step.params).length === 0}
            <p class="muted">None</p>
          {:else}
            <dl>
              {#each Object.entries(step.params) as [name, value] (name)}
                <dt class="mono">{name}</dt>
                <dd class="mono">{json(value)}</dd>
              {/each}
            </dl>
          {/if}
        </section>

        <section>
          <h3>Inputs</h3>
          {#if step.inputs.length === 0}
            <p class="muted">None</p>
          {:else}
            <ul class="ports">
              {#each step.inputs as input (input.name)}
                <li>
                  <span class="mono port">{input.name}</span>
                  {#if input.contract}
                    <span class="contract mono">{input.contract}</span>
                  {/if}
                  <span class="source" title={sourceTitle(input.source)}>
                    ←
                    {#if input.source.kind === "literal"}
                      <code>{json(input.source.value)}</code>
                    {:else if input.source.kind === "context"}
                      run context <code>{input.source.field}</code>
                    {:else}
                      <a href={`#${anchor(input.source.step)}`}
                        ><code>{input.source.step}</code></a
                      >
                      output <code>{input.source.output}</code>
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section>
          <h3>Outputs</h3>
          {#if step.outputs.length === 0}
            <p class="muted">None</p>
          {:else}
            <ul class="ports">
              {#each step.outputs as output (output.name)}
                <li>
                  <span class="mono port" title={output.description}
                    >{output.name}</span
                  >
                  <span class="contract mono">{output.contract}</span>
                  <span class="source">
                    →
                    {#if output.usedBy.length === 0}
                      <span class="muted">not used by a later step</span>
                    {:else}
                      {#each output.usedBy as use, index (`${use.step}/${use.input}`)}
                        {#if index > 0},
                        {/if}
                        <a href={`#${anchor(use.step)}`}
                          ><code>{use.step}</code></a
                        >
                        <code>{use.input}</code>
                      {/each}
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    </li>
  {/each}
</ol>

<style>
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .step {
    padding: 0.85rem 1rem;
    scroll-margin-top: 1rem;
  }
  .step:target {
    border-color: var(--accent);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.6rem;
  }
  .position {
    display: inline-grid;
    place-items: center;
    min-width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    background: var(--accent);
    color: var(--surface);
    font-size: 0.8rem;
    font-weight: 700;
  }
  .type,
  .contract {
    color: var(--muted);
  }
  .contract {
    font-size: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 0.3rem;
  }
  .description {
    margin: 0.35rem 0 0.5rem;
  }
  .sections {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
  }
  h3 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
    margin: 0 0 0.35rem;
  }
  section p {
    margin: 0;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.2rem 0.75rem;
    margin: 0;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .ports {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .ports li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
  }
  .port {
    font-weight: 600;
  }
  .source {
    overflow-wrap: anywhere;
  }
  code {
    font-family: var(--mono);
    font-size: 0.85em;
  }

  @media (max-width: 720px) {
    .sections {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
