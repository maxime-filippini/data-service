<script lang="ts">
  import { untrack } from "svelte";

  import { type DatasetProviders, type RegisterInput, registerSymbol } from "./api";

  let {
    options,
    initial,
    existing,
    onsaved,
    oncancel,
  }: {
    options: DatasetProviders;
    /** The symbol being edited; omit to add one. */
    initial?: RegisterInput | undefined;
    /** `dataset/symbol` keys already registered, so adding never overwrites one. */
    existing: ReadonlySet<string>;
    /** Called with the symbols saved. `done` is false when some failed and the form stays open. */
    onsaved: (symbols: string[], done: boolean) => void;
    oncancel: () => void;
  } = $props();

  const datasets = $derived(Object.keys(options));
  const editing = untrack(() => initial !== undefined);

  let form = $state<RegisterInput>(
    untrack(() => ({ ...(initial ?? { dataset: "", symbol: "", provider: "", backfillStartDate: "2016-01-01", enabled: true }) })),
  );
  let saving = $state(false);
  let error = $state<string | null>(null);

  const providers = $derived(options[form.dataset] ?? []);

  // Pick sensible defaults once the options arrive or the dataset changes.
  $effect(() => {
    if (form.dataset === "" && datasets.length > 0) form.dataset = datasets[0]!;
  });
  $effect(() => {
    if (!providers.includes(form.provider) && providers.length > 0) form.provider = providers[0]!;
  });

  const today = new Date().toISOString().slice(0, 10);
  const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]*(\.[A-Z0-9][A-Z0-9-]*)?$/;
  const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  /** Symbols typed into the add form, uppercased and without duplicates. */
  const parseSymbols = (text: string) => [...new Set(text.toUpperCase().split(/[\s,;]+/).filter(Boolean))];
  const typed = $derived(editing ? [] : parseSymbols(form.symbol));
  let progress = $state(0);

  const submitEdit = async () => {
    try {
      await registerSymbol(form);
      onsaved([form.symbol], true);
    } catch (cause) {
      error = describe(cause);
    }
  };

  const submitAdd = async () => {
    const invalid = typed.filter((symbol) => !SYMBOL_PATTERN.test(symbol));
    if (invalid.length > 0) {
      error = `Not a valid symbol: ${invalid.join(", ")}. Use letters, digits and dashes, with an optional exchange suffix such as .US.`;
      return;
    }
    const taken = typed.filter((symbol) => existing.has(`${form.dataset}/${symbol}`));
    if (taken.length > 0) {
      error = `Already registered for ${form.dataset}: ${taken.join(", ")}. Remove them here, or use Edit on their rows.`;
      return;
    }
    const added: string[] = [];
    const failures: string[] = [];
    progress = 0;
    for (const symbol of typed) {
      try {
        await registerSymbol({ ...form, symbol });
        added.push(symbol);
      } catch (cause) {
        failures.push(`${symbol}: ${describe(cause)}`);
      }
      progress++;
    }
    if (failures.length > 0) {
      // Keep only the failed symbols so they can be fixed and retried.
      form.symbol = typed.filter((symbol) => !added.includes(symbol)).join("\n");
      error = `${failures.length} of ${typed.length} could not be added. ${failures.join("; ")}`;
    }
    onsaved(added, failures.length === 0);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    saving = true;
    error = null;
    try {
      await (editing ? submitEdit() : submitAdd());
    } finally {
      saving = false;
    }
  };
</script>

<form class="card" onsubmit={submit}>
  <h2>{editing ? `Edit ${form.symbol}` : "Add symbols"}</h2>
  <div class="fields">
    <label class="field">
      Dataset
      <select bind:value={form.dataset} disabled={editing} required>
        {#each datasets as dataset (dataset)}
          <option value={dataset}>{dataset}</option>
        {/each}
      </select>
    </label>
    {#if editing}
      <label class="field">
        Symbol
        <input value={form.symbol} disabled />
      </label>
    {:else}
      <label class="field symbols">
        Symbols
        <textarea
          bind:value={form.symbol}
          placeholder={"AAPL.US MSFT.US\nBRK-B.US"}
          rows="3"
          required
          title="Separate symbols with spaces, commas or new lines"
        ></textarea>
      </label>
    {/if}
    <label class="field">
      Provider
      <select bind:value={form.provider} required>
        {#each providers as provider (provider)}
          <option value={provider}>{provider}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      History from
      <input type="date" bind:value={form.backfillStartDate} max={today} required />
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={form.enabled} />
      On the daily schedule
    </label>
  </div>
  {#if !editing}
    <p class="muted hint">
      Separate symbols with spaces, commas or new lines. They all get the settings above.
    </p>
  {:else}
    <p class="muted hint">
      Changing the start date or provider applies from the next download, which rebuilds the full history.
    </p>
  {/if}
  {#if error}
    <div class="error">{error}</div>
  {/if}
  <div class="actions">
    <button type="button" onclick={oncancel} disabled={saving}>Cancel</button>
    <button type="submit" class="primary" disabled={saving || (!editing && typed.length === 0)}>
      {#if editing}
        Save
      {:else if saving}
        Adding {progress} of {typed.length}…
      {:else}
        Add {typed.length > 1 ? `${typed.length} symbols` : "symbol"}
      {/if}
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
  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem;
  }
  .symbols {
    flex: 1 1 16rem;
  }
  .symbols textarea {
    width: 100%;
    font: inherit;
    resize: vertical;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding-bottom: 0.35rem;
  }
  .hint {
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
  }
  .error {
    margin: 0.75rem 0 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
</style>
