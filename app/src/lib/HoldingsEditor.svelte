<script lang="ts">
  import { emptyRow, type HoldingRow, parsePasted } from "./holdings";

  let {
    rows = $bindable(),
    symbols,
  }: {
    rows: HoldingRow[];
    /** Tracked `prices_eod` symbols, suggested while typing. */
    symbols: readonly string[];
  } = $props();

  let pasting = $state(false);
  let pasted = $state("");
  let skipped = $state<string[]>([]);

  const listId = `holding-symbols-${Math.random().toString(36).slice(2)}`;

  const filled = $derived(rows.filter((row) => row.symbol.trim() !== "").length);
  const total = $derived(
    rows.reduce((sum, row) => {
      const weight = Number(row.weight);
      return row.weight.trim() !== "" && Number.isFinite(weight) ? sum + weight : sum;
    }, 0),
  );

  const applyPaste = () => {
    const parsed = parsePasted(pasted);
    skipped = parsed.skipped;
    if (parsed.rows.length === 0) return;
    rows = parsed.rows;
    pasted = "";
    pasting = false;
  };

  const removeRow = (index: number) => {
    rows = rows.length === 1 ? [emptyRow()] : rows.filter((_, i) => i !== index);
  };
</script>

<div class="holdings">
  <div class="head">
    <span class="muted">
      {filled} holding{filled === 1 ? "" : "s"} · weights sum to {Number(total.toFixed(10))}
    </span>
    <button type="button" class="link" onclick={() => ((pasting = !pasting), (skipped = []))}>
      {pasting ? "Edit rows" : "Paste rows"}
    </button>
  </div>

  {#if pasting}
    <textarea
      bind:value={pasted}
      rows="8"
      placeholder={"AAPL.US\t0.6\nMSFT.US\t0.4"}
      aria-label="Pasted holdings"
    ></textarea>
    <p class="muted hint">
      One holding per line: a symbol and a weight, separated by a tab, comma, semicolon or space. Pasting replaces
      the rows below.
    </p>
    <div class="paste-actions">
      <button type="button" onclick={applyPaste} disabled={pasted.trim() === ""}>Use these rows</button>
    </div>
  {:else}
    <datalist id={listId}>
      {#each symbols as symbol (symbol)}
        <option value={symbol}></option>
      {/each}
    </datalist>
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th class="num">Weight</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row, index (index)}
          <tr>
            <td>
              <input
                bind:value={row.symbol}
                list={listId}
                placeholder="AAPL.US"
                aria-label={`Symbol ${index + 1}`}
                oninput={() => (row.symbol = row.symbol.toUpperCase())}
              />
            </td>
            <td class="num">
              <input bind:value={row.weight} inputmode="decimal" placeholder="0.5" aria-label={`Weight ${index + 1}`} />
            </td>
            <td class="remove">
              <button type="button" class="link" onclick={() => removeRow(index)} aria-label={`Remove row ${index + 1}`}>
                Remove
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <button type="button" class="add" onclick={() => (rows = [...rows, emptyRow()])}>Add row</button>
  {/if}

  {#if skipped.length > 0}
    <p class="skipped">Skipped {skipped.length} line{skipped.length === 1 ? "" : "s"} without a numeric weight: {skipped.slice(0, 5).join("; ")}{skipped.length > 5 ? "…" : ""}</p>
  {/if}
</div>

<style>
  .holdings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  textarea {
    width: 100%;
    font-family: var(--mono);
    resize: vertical;
  }
  .hint {
    margin: 0;
    font-size: 0.85rem;
  }
  .paste-actions {
    display: flex;
    justify-content: flex-end;
  }
  table {
    max-width: 32rem;
  }
  th,
  td {
    padding: 0.25rem 0.5rem 0.25rem 0;
    border: none;
  }
  td input {
    width: 100%;
    min-width: 0;
  }
  td.num input {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .remove {
    width: 1%;
  }
  .add {
    align-self: flex-start;
  }
  .skipped {
    margin: 0;
    font-size: 0.85rem;
    color: var(--bad-fg);
    overflow-wrap: anywhere;
  }
</style>
