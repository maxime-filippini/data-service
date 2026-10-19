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
    onsaved: (saved: RegisterInput) => void;
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

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    saving = true;
    error = null;
    const input = { ...form, symbol: form.symbol.trim().toUpperCase() };
    if (!editing && existing.has(`${input.dataset}/${input.symbol}`)) {
      error = `${input.symbol} is already registered for ${input.dataset}. Use Edit on its row instead.`;
      saving = false;
      return;
    }
    try {
      await registerSymbol(input);
      onsaved(input);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  };
</script>

<form class="card" onsubmit={submit}>
  <h2>{editing ? `Edit ${form.symbol}` : "Add a symbol"}</h2>
  <div class="fields">
    <label class="field">
      Dataset
      <select bind:value={form.dataset} disabled={editing} required>
        {#each datasets as dataset (dataset)}
          <option value={dataset}>{dataset}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      Symbol
      <input
        bind:value={form.symbol}
        placeholder="AAPL.US"
        disabled={editing}
        required
        pattern="[A-Za-z0-9][A-Za-z0-9\-]*(\.[A-Za-z0-9][A-Za-z0-9\-]*)?"
        title="Letters, digits and dashes, with an optional exchange suffix such as .US"
      />
    </label>
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
  {#if editing}
    <p class="muted hint">
      Changing the start date or provider applies from the next download, which rebuilds the full history.
    </p>
  {/if}
  {#if error}
    <div class="error">{error}</div>
  {/if}
  <div class="actions">
    <button type="button" onclick={oncancel} disabled={saving}>Cancel</button>
    <button type="submit" class="primary" disabled={saving}>{editing ? "Save" : "Add symbol"}</button>
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
