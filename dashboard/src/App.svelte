<script lang="ts">
  import { fetchMe } from "./lib/api";
  import { href, route } from "./lib/router.svelte";
  import Runs from "./views/Runs.svelte";
  import Explore from "./views/Explore.svelte";
  import Symbols from "./views/Symbols.svelte";

  const me = fetchMe().catch(() => undefined);
</script>

<header>
  <span class="title">Data service</span>
  <nav>
    <a href={href("runs")} class:active={route.view === "runs"}>Ingestion runs</a>
    <a href={href("symbols")} class:active={route.view === "symbols"}>Symbols</a>
    <a href={href("explore")} class:active={route.view === "explore"}>Explore data</a>
  </nav>
  <span class="user muted">
    {#await me then user}<span title={user?.email}>{user?.email ?? ""}</span>{/await}
  </span>
</header>

<main>
  {#if route.view === "symbols"}
    <Symbols />
  {:else if route.view === "explore"}
    <Explore />
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
    white-space: nowrap;
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
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  main {
    padding: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }

  /* Phones: title and user on top, the tabs on their own full-width row. */
  @media (max-width: 720px) {
    header {
      flex-wrap: wrap;
      gap: 0 1rem;
      height: auto;
      padding: 0 1rem;
    }
    .title {
      padding: 0.6rem 0;
    }
    .user {
      flex: 1 1 0;
      text-align: right;
    }
    nav {
      order: 1;
      flex: 1 0 100%;
      height: 2.75rem;
      margin: 0 -1rem;
      padding: 0 0.25rem;
      overflow-x: auto;
      scrollbar-width: none;
      border-top: 1px solid var(--border);
    }
    nav a {
      flex: 1 0 auto;
      justify-content: center;
      white-space: nowrap;
    }
    main {
      padding: 1rem 0.75rem;
    }
  }
</style>
