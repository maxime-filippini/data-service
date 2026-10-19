<script lang="ts">
  import { fetchMe } from "./lib/api";
  import { href, route } from "./lib/router.svelte";
  import Runs from "./views/Runs.svelte";
  import Symbols from "./views/Symbols.svelte";

  const me = fetchMe().catch(() => undefined);
</script>

<header>
  <span class="title">Data service</span>
  <nav>
    <a href={href("runs")} class:active={route.view === "runs"}>Ingestion runs</a>
    <a href={href("symbols")} class:active={route.view === "symbols"}>Symbols</a>
  </nav>
  <span class="user muted">
    {#await me then user}{user?.email ?? ""}{/await}
  </span>
</header>

<main>
  {#if route.view === "symbols"}
    <Symbols />
  {:else}
    <Runs />
  {/if}
</main>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0 1.5rem;
    height: 3.25rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .title {
    font-weight: 700;
  }
  nav {
    display: flex;
    gap: 0.25rem;
    height: 100%;
  }
  nav a {
    display: flex;
    align-items: center;
    padding: 0 0.75rem;
    color: var(--muted);
    border-bottom: 2px solid transparent;
  }
  nav a:hover {
    color: var(--text);
    text-decoration: none;
  }
  nav a.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .user {
    margin-left: auto;
    font-size: 0.85rem;
  }
  main {
    padding: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }
</style>
