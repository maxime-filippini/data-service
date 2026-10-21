<script lang="ts">
  import { untrack } from "svelte";

  import { isCronError, parseCron } from "../../../src/calculations/cron";
  import {
    type Calculation,
    type CalculationTypeInfo,
    createCalculation,
    type PortfolioSummary,
    updateCalculation,
  } from "./api";
  import { defaultParams, describeParams, formatParams, parseParams } from "./params";

  let {
    types,
    portfolios,
    initial,
    onsaved,
    oncancel,
  }: {
    types: readonly CalculationTypeInfo[];
    portfolios: readonly PortfolioSummary[];
    /** The calculation being edited; omit to create one. */
    initial?: Calculation | undefined;
    onsaved: (calculation: Calculation) => void;
    oncancel: () => void;
  } = $props();

  const editing = untrack(() => initial !== undefined);

  const CRON_PRESETS = [
    { label: "Daily", cron: "0 6 * * *" },
    { label: "Weekdays", cron: "0 6 * * 1-5" },
    { label: "Monthly", cron: "0 6 1 * *" },
  ];

  let name = $state(untrack(() => initial?.name ?? ""));
  let type = $state(untrack(() => initial?.type ?? ""));
  let cron = $state(untrack(() => initial?.cron ?? "0 6 * * *"));
  let enabled = $state(untrack(() => initial?.enabled ?? true));
  /** In the order they run. */
  let portfolioIds = $state<string[]>(untrack(() => [...(initial?.portfolioIds ?? [])]));
  let paramsText = $state(untrack(() => (initial ? formatParams(initial.params) : "{}")));
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Pick the first type once the list arrives, with its defaults.
  $effect(() => {
    if (!editing && type === "" && types.length > 0) chooseType(types[0]!.name);
  });

  const info = $derived(types.find((candidate) => candidate.name === type));
  const help = $derived(describeParams(info?.paramsSchema));
  const parsedParams = $derived(parseParams(paramsText));
  const cronError = $derived.by(() => {
    const parsed = parseCron(cron.trim());
    return isCronError(parsed) ? parsed.error : null;
  });
  const portfolioNames = $derived(new Map(portfolios.map((p) => [p.id, p.name])));

  function chooseType(next: string) {
    type = next;
    const chosen = types.find((candidate) => candidate.name === next);
    paramsText = formatParams(defaultParams(chosen?.paramsSchema));
    if (chosen && !chosen.takesPortfolio) portfolioIds = [];
  }

  const togglePortfolio = (id: string) => {
    portfolioIds = portfolioIds.includes(id) ? portfolioIds.filter((p) => p !== id) : [...portfolioIds, id];
  };

  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  /**
   * Only what changed, so the engine is only asked about params or portfolios
   * that did. Renaming or pausing then works even if the type is gone.
   */
  const changedFields = <T extends Record<string, unknown>>(current: Calculation, fields: T): Partial<T> =>
    Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key as keyof Calculation]),
      ),
    ) as Partial<T>;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    error = null;
    if ("error" in parsedParams) {
      error = parsedParams.error;
      return;
    }
    if (cronError) {
      error = `Cron: ${cronError}`;
      return;
    }
    if (info?.takesPortfolio && portfolioIds.length === 0) {
      error = `${type} runs over portfolios. Pick at least one.`;
      return;
    }
    const fields = { name, params: parsedParams.params, portfolioIds, cron: cron.trim(), enabled };
    saving = true;
    try {
      const saved = initial
        ? await updateCalculation(initial.id, changedFields(initial, fields))
        : await createCalculation({ ...fields, type });
      onsaved(saved);
    } catch (cause) {
      error = describe(cause);
    } finally {
      saving = false;
    }
  };
</script>

<form class="card" onsubmit={submit}>
  <h2>{editing ? `Edit ${initial?.name}` : "New calculation"}</h2>
  <div class="layout">
    <div class="fields">
      <label class="field">
        Name
        <input bind:value={name} required maxlength="200" placeholder="Core ex-ante vol" />
      </label>

      <label class="field">
        Type
        {#if editing}
          <input value={type} disabled title="A calculation's type can't change; create a new calculation instead" />
        {:else}
          <select value={type} onchange={(event) => chooseType(event.currentTarget.value)} required>
            {#each types as candidate (candidate.name)}
              <option value={candidate.name}>{candidate.name}</option>
            {/each}
          </select>
        {/if}
      </label>
      {#if info}
        <p class="muted hint">{info.description}</p>
      {:else if editing && types.length > 0}
        <p class="bad hint">The engine no longer has this type, so its runs fail.</p>
      {/if}

      <div class="field">
        Cron (UTC)
        <div class="cron">
          <input bind:value={cron} required class="mono" aria-label="Cron expression" aria-invalid={cronError !== null} />
          {#each CRON_PRESETS as preset (preset.cron)}
            <button type="button" onclick={() => (cron = preset.cron)} title={preset.cron}>{preset.label}</button>
          {/each}
        </div>
        {#if cronError}
          <span class="bad">{cronError}</span>
        {:else}
          <span class="muted">
            Minute, hour, day of month, month, day of week. Checked hourly, so the minute has no effect. Runs
            calculate as of the previous UTC day.
          </span>
        {/if}
      </div>

      <label class="check">
        <input type="checkbox" bind:checked={enabled} />
        Enabled (runs on its cron)
      </label>

      {#if info?.takesPortfolio || portfolioIds.length > 0}
        <fieldset>
          <legend>Portfolios <span class="muted">· the type runs once for each, in this order</span></legend>
          {#if portfolioIds.length > 1}
            <ol class="chosen">
              {#each portfolioIds as id (id)}
                <li>
                  {portfolioNames.get(id) ?? id}
                  <button type="button" class="link" onclick={() => togglePortfolio(id)}>Remove</button>
                </li>
              {/each}
            </ol>
          {/if}
          {#if portfolios.length === 0}
            <p class="muted hint">No portfolios yet. Create one under Portfolios first.</p>
          {:else}
            <div class="choices">
              {#each portfolios as p (p.id)}
                <label class="check">
                  <input type="checkbox" checked={portfolioIds.includes(p.id)} onchange={() => togglePortfolio(p.id)} />
                  {p.name}
                  {#if p.snapshotCount === 0}<span class="muted">(no snapshots)</span>{/if}
                </label>
              {/each}
            </div>
          {/if}
        </fieldset>
      {/if}

      <label class="field params">
        Params (JSON)
        <textarea
          bind:value={paramsText}
          rows={Math.min(16, Math.max(5, paramsText.split("\n").length + 1))}
          spellcheck="false"
          class="mono"
          aria-invalid={"error" in parsedParams}
        ></textarea>
      </label>
      {#if "error" in parsedParams}
        <p class="bad hint">{parsedParams.error}</p>
      {:else}
        <p class="muted hint">The engine checks the params when you save and fills in defaults for any left out.</p>
      {/if}
    </div>

    {#if info}
      <aside class="help">
        <h3>{info.name} params</h3>
        {#if help.length === 0}
          <p class="muted">This type takes no params.</p>
        {:else}
          <dl>
            {#each help as param (param.name)}
              <dt>
                <span class="mono">{param.name}</span>
                <span class="muted">{param.type}{param.required ? ", required" : ""}</span>
              </dt>
              <dd>
                {#if param.description}<span>{param.description}</span>{/if}
                <span class="muted">
                  {#if param.default !== undefined}Default <span class="mono">{param.default}</span>.{/if}
                  {#if param.constraints.length > 0}{param.constraints.join(", ")}.{/if}
                </span>
              </dd>
            {/each}
          </dl>
          <button type="button" onclick={() => (paramsText = formatParams(defaultParams(info?.paramsSchema)))}>
            Reset to defaults
          </button>
        {/if}
        <h3>Output columns</h3>
        <p class="mono columns">
          {Object.entries(info.output)
            .map(([column, dtype]) => `${column}: ${dtype}`)
            .join(", ")}, as_of, portfolio_id
        </p>
        <details>
          <summary>Params JSON Schema</summary>
          <pre>{formatParams(info.paramsSchema)}</pre>
        </details>
      </aside>
    {/if}
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}
  <div class="actions">
    <button type="button" onclick={oncancel} disabled={saving}>Cancel</button>
    <button type="submit" class="primary" disabled={saving || name.trim() === "" || type === ""}>
      {saving ? "Saving…" : editing ? "Save" : "Create calculation"}
    </button>
  </div>
</form>

<style>
  form {
    padding: 1rem;
    margin-bottom: 1rem;
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 1.25rem;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  div.field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .field input,
  .field select {
    color: var(--text);
  }
  .cron {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .cron input {
    flex: 1 1 10rem;
    min-width: 0;
  }
  [aria-invalid="true"] {
    border-color: var(--bad-fg);
  }
  .hint {
    margin: -0.4rem 0 0;
    font-size: 0.85rem;
  }
  .bad {
    color: var(--bad-fg);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem 0.75rem;
    margin: 0;
  }
  legend {
    font-size: 0.8rem;
    padding: 0 0.25rem;
  }
  .chosen {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1.5rem;
  }
  .chosen li {
    display: flex;
    gap: 0.75rem;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    max-height: 12rem;
    overflow-y: auto;
  }
  .params textarea {
    width: 100%;
    resize: vertical;
    color: var(--text);
  }
  .cron input,
  .params textarea {
    font-size: 0.9rem;
  }
  .help {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    background: var(--bg);
    font-size: 0.85rem;
    min-width: 0;
    align-self: start;
  }
  dl {
    margin: 0 0 0.75rem;
  }
  dt {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-weight: 600;
  }
  dd {
    display: flex;
    flex-direction: column;
    margin: 0.1rem 0 0.6rem;
  }
  .help button {
    margin-bottom: 1rem;
  }
  .columns {
    margin: 0 0 0.75rem;
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
  }
  pre {
    margin: 0.5rem 0 0;
    max-height: 20rem;
    overflow: auto;
    font-size: 0.8rem;
  }
  form > .error {
    margin: 0.75rem 0 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  @media (max-width: 900px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 720px) {
    .actions button {
      flex: 1;
    }
  }
</style>
