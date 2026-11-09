<script lang="ts">
  import { page } from "$app/state";

  import "../app.css";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  const SECTIONS = [
    { path: "/runs", label: "Ingestion runs" },
    { path: "/symbols", label: "Symbols" },
    { path: "/portfolios", label: "Portfolios" },
    { path: "/calculations", label: "Calculations" },
    { path: "/explore", label: "Explore data" },
  ];

  const isActive = (path: string) => page.url.pathname === path || page.url.pathname.startsWith(`${path}/`);
</script>

<svelte:head>
  <title>Data service</title>
</svelte:head>

<header>
  <a class="title" href="/" class:active={page.url.pathname === "/"}>Data service</a>
  <nav>
    {#each SECTIONS as section (section.path)}
      <a href={section.path} class:active={isActive(section.path)}>{section.label}</a>
    {/each}
    <!-- The docs are a separate (Astro) site, so leave the app to open them. -->
    <a href="/docs/" rel="external">Docs</a>
  </nav>
  <span class="user muted"><span title={data.user.email}>{data.user.email}</span></span>
</header>

<main>
  {@render children()}
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
    color: var(--text);
  }
  .title:hover {
    text-decoration: none;
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
