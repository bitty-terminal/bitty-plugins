/**
 * Route-level pages composed from the store's custom elements.
 *
 * Pages receive the loaded registry and return a title plus a DOM node; the
 * bootstrap in `main.ts` swaps them into `<main>`.
 */

import { el, externalLink, link } from "./components/dom.ts";
import "./components/install-command.ts";
import "./components/plugin-card.ts";
import "./components/plugin-detail.ts";
import "./components/plugin-filters.ts";
import "./components/plugin-search.ts";
import type { PluginFiltersDetail } from "./components/plugin-filters.ts";
import type { PluginSearchDetail } from "./components/plugin-search.ts";
import {
  authorsOf,
  categoriesOf,
  kindsOf,
  pluginsByAuthor,
  pluginsByCategory,
  type Plugin,
  type Registry,
} from "./registry.ts";
import { filterPlugins } from "./search.ts";

export interface Page {
  title: string;
  node: HTMLElement;
}

function cardItem(plugin: Plugin): HTMLLIElement {
  const card = el("plugin-card", {});
  card.plugin = plugin;
  return el("li", {}, card);
}

function cardList(plugins: Plugin[]): HTMLElement {
  return el("ul", { class: "cards" }, ...plugins.map(cardItem));
}

export function entrySummary(registry: Registry): string {
  return `${registry.plugins.length} entries · ${authorsOf(registry).length} authors · generated ${registry.generated_at}`;
}

export function pluginPage(plugin: Plugin): Page {
  const detail = el("plugin-detail", {});
  detail.plugin = plugin;
  return { title: `${plugin.name} · Bitty Plugins`, node: detail };
}

export function homePage(registry: Registry): Page {
  let query = "";
  let filters: PluginFiltersDetail = { kind: "", category: "", scope: "all" };

  const search = el("plugin-search", {});
  const filterBar = el("plugin-filters", {});
  filterBar.categories = categoriesOf(registry);
  filterBar.kinds = kindsOf(registry);

  const status = el("p", { class: "status", role: "status" });
  const results = el("div", { class: "results" });

  const update = (): void => {
    const plugins = filterPlugins(registry.plugins, { query, ...filters });
    status.textContent = `${plugins.length} of ${registry.plugins.length} entries`;
    results.replaceChildren(
      plugins.length > 0
        ? cardList(plugins)
        : el("p", {}, "No entries match the current search and filters."),
    );
  };

  search.addEventListener("plugin-search", (event) => {
    query = (event as CustomEvent<PluginSearchDetail>).detail.query;
    update();
  });
  filterBar.addEventListener("plugin-filters", (event) => {
    filters = (event as CustomEvent<PluginFiltersDetail>).detail;
    update();
  });
  update();

  const categories = categoriesOf(registry);
  const node = el(
    "div",
    {},
    el("h1", {}, "Bitty plugin directory"),
    el(
      "p",
      { class: "lede" },
      "Official and community entries from the Bitty registry. Official plugins are pinned submodules; community entries are metadata only.",
    ),
    el("p", { class: "generated" }, entrySummary(registry)),
    search,
    filterBar,
    status,
    categories.length > 0
      ? el(
          "nav",
          { "aria-label": "Categories" },
          el(
            "ul",
            { class: "chips" },
            ...categories.map((category) =>
              el(
                "li",
                {},
                link(`/categories/${encodeURIComponent(category)}`, category),
              ),
            ),
          ),
        )
      : null,
    results,
  );
  return { title: "Bitty Plugin Directory", node };
}

export function categoryPage(registry: Registry, category: string): Page {
  const plugins = pluginsByCategory(registry, category);
  const node = el(
    "div",
    {},
    el("p", { class: "breadcrumb" }, link("/", "Directory"), " / Categories"),
    el("h1", {}, `Category: ${category}`),
    el("p", { class: "status", role: "status" }, `${plugins.length} entries`),
    plugins.length > 0
      ? cardList(plugins)
      : el("p", {}, "No entries in this category yet."),
  );
  return { title: `${category} · Bitty Plugins`, node };
}

export function authorPage(registry: Registry, author: string): Page {
  const plugins = pluginsByAuthor(registry, author);
  const node = el(
    "div",
    {},
    el("p", { class: "breadcrumb" }, link("/", "Directory"), " / Authors"),
    el("h1", {}, `Author: ${author}`),
    el("p", { class: "status", role: "status" }, `${plugins.length} entries`),
    plugins.length > 0
      ? cardList(plugins)
      : el("p", {}, "No entries by this author yet."),
  );
  return { title: `${author} · Bitty Plugins`, node };
}

export function sdkPage(): Page {
  const node = el(
    "div",
    {},
    el("h1", {}, "Build with the Bitty plugin SDK"),
    el(
      "p",
      { class: "lede" },
      "The SDK provides Lua helpers, editor types, a mock host, and test tooling. The template scaffolds a repository with CI and manifest examples.",
    ),
    el(
      "ul",
      { class: "link-list" },
      el(
        "li",
        {},
        externalLink(
          "https://github.com/bitty-terminal/bitty-plugin-sdk",
          "bitty-plugin-sdk",
        ),
        " — helpers, typings, mock host, and test harness.",
      ),
      el(
        "li",
        {},
        externalLink(
          "https://github.com/bitty-terminal/bitty-plugin-template",
          "bitty-plugin-template",
        ),
        " — repository scaffold, CI, and manifest examples.",
      ),
    ),
    el(
      "section",
      {},
      el("h2", {}, "Start from the template"),
      el(
        "pre",
        {},
        el(
          "code",
          {},
          "git clone https://github.com/bitty-terminal/bitty-plugin-template my-plugin",
        ),
      ),
      el(
        "p",
        { class: "note" },
        "Plugin manifests, capability rules, and API contracts are owned by the canonical documentation corpus, not by this store.",
      ),
    ),
    el(
      "p",
      {},
      link("/create-plugin", "Create a plugin"),
      " to publish an entry, or ",
      link("/", "browse the directory"),
      ".",
    ),
  );
  return { title: "SDK · Bitty Plugins", node };
}

export function createPage(): Page {
  const node = el(
    "div",
    {},
    el("h1", {}, "Create a plugin"),
    el(
      "ol",
      { class: "steps" },
      el(
        "li",
        {},
        "Start from the ",
        externalLink(
          "https://github.com/bitty-terminal/bitty-plugin-template",
          "plugin template",
        ),
        " and implement your plugin in your own repository.",
      ),
      el(
        "li",
        {},
        "Declare a ",
        el("code", {}, "bitty-plugin.toml"),
        " manifest with an id, capabilities, and compatibility ranges.",
      ),
      el(
        "li",
        {},
        "Publish a community registry entry as ",
        el("code", {}, "registry/community/<author>-<slug>.toml"),
        " with minimal hand-maintained metadata.",
      ),
      el(
        "li",
        {},
        "Open a pull request against this repository; CI validates the entry and regenerates the index.",
      ),
    ),
    el(
      "section",
      {},
      el("h2", {}, "Registry entry example"),
      el(
        "pre",
        {},
        el(
          "code",
          {},
          'id = "yourhandle.your-plugin"\nname = "Your Plugin"\nrepository = "https://github.com/you/your-plugin"\nlicense = "MIT"\n\n[compatibility]\nbitty = ">=0.5,<1.0"',
        ),
      ),
    ),
    el(
      "p",
      {},
      "Read ",
      externalLink(
        "https://github.com/bitty-terminal/bitty-plugins/blob/main/CONTRIBUTING.md",
        "CONTRIBUTING.md",
      ),
      " before submitting. Community entries are metadata only and are never vendored into this repository.",
    ),
  );
  return { title: "Create a plugin · Bitty Plugins", node };
}

export function notFoundPage(path: string): Page {
  const node = el(
    "div",
    {},
    el("h1", {}, "Not found"),
    el("p", {}, `No route matches ${path}.`),
    el("p", {}, link("/", "Back to the directory")),
  );
  return { title: "Not found · Bitty Plugins", node };
}
