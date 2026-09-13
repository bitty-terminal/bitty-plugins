/**
 * Route views. Registry values are untrusted display data and are always
 * rendered as text nodes or attributes — never interpolated into HTML.
 */

import {
  authorsOf,
  categoriesOf,
  installCommand,
  kindLabel,
  pluginById,
  pluginsByAuthor,
  pluginsByCategory,
  type Plugin,
  type Registry,
} from "./registry.ts";
import type { Route } from "./router.ts";

export interface View {
  title: string;
  node: HTMLElement;
}

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? "" : value);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string") {
      parent.appendChild(document.createTextNode(child));
    } else {
      parent.appendChild(child);
    }
  }
}

function link(path: string, label: string): HTMLAnchorElement {
  return el("a", { href: path, "data-link": true }, label);
}

function externalLink(url: string, label: string): HTMLAnchorElement {
  return el(
    "a",
    { href: url, rel: "noopener noreferrer", target: "_blank" },
    label,
  );
}

function badge(text: string, variant?: string): HTMLElement {
  return el(
    "span",
    { class: `badge${variant ? ` badge-${variant}` : ""}` },
    text,
  );
}

function matches(plugin: Plugin, query: string): boolean {
  if (query.length === 0) return true;
  const haystack = [
    plugin.id,
    plugin.name,
    plugin.author ?? "",
    plugin.description ?? "",
    ...(plugin.tags ?? []),
    ...(plugin.categories ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function pluginCard(plugin: Plugin): HTMLElement {
  const badges = el(
    "p",
    { class: "badges" },
    badge(
      plugin.official ? "Official" : "Community",
      plugin.official ? "official" : "community",
    ),
    badge(kindLabel(plugin.kind)),
  );
  const card = el(
    "article",
    { class: "card" },
    el(
      "h3",
      {},
      link(`/plugins/${encodeURIComponent(plugin.id)}`, plugin.name),
    ),
    badges,
    plugin.description
      ? el("p", { class: "card-description" }, plugin.description)
      : null,
    el(
      "p",
      { class: "card-meta" },
      el("code", {}, plugin.id),
      plugin.metadata?.version ? ` · v${plugin.metadata.version}` : "",
      plugin.license ? ` · ${plugin.license}` : "",
    ),
  );
  if (plugin.tags && plugin.tags.length > 0) {
    card.appendChild(
      el(
        "ul",
        { class: "chips", "aria-label": "Tags" },
        ...plugin.tags.map((tag) => el("li", {}, tag)),
      ),
    );
  }
  return card;
}

function cardList(plugins: Plugin[]): HTMLElement {
  return el("ul", { class: "cards" }, ...plugins.map(pluginCard));
}

function renderHome(registry: Registry): View {
  const input = el("input", {
    type: "search",
    id: "search",
    placeholder: "Search by name, id, tag, or author…",
    autocomplete: "off",
  });
  const status = el("p", { class: "status", role: "status" });
  const list = el("div", {});
  const update = (): void => {
    const query = input.value.trim().toLowerCase();
    const filtered = registry.plugins.filter((plugin) =>
      matches(plugin, query),
    );
    list.replaceChildren(cardList(filtered));
    status.textContent = `${filtered.length} of ${registry.plugins.length} entries`;
  };
  input.addEventListener("input", update);
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
    el(
      "div",
      { class: "search" },
      el("label", { for: "search" }, "Search"),
      input,
    ),
    status,
    categories.length > 0
      ? el(
          "nav",
          { class: "chips", "aria-label": "Categories" },
          ...categories.map((category) =>
            el(
              "li",
              {},
              link(`/categories/${encodeURIComponent(category)}`, category),
            ),
          ),
        )
      : null,
    list,
  );
  return { title: "Bitty Plugin Directory", node };
}

function renderPlugin(registry: Registry, id: string): View {
  const plugin = pluginById(registry, id);
  if (!plugin) return renderNotFound(`/plugins/${id}`);

  const facts = el("dl", { class: "facts" });
  const addFact = (term: string, value: Child): void => {
    facts.appendChild(el("dt", {}, term));
    facts.appendChild(el("dd", {}, value));
  };
  addFact("Kind", kindLabel(plugin.kind));
  if (plugin.author) {
    addFact(
      "Author",
      link(`/authors/${encodeURIComponent(plugin.author)}`, plugin.author),
    );
  }
  addFact("Repository", externalLink(plugin.repository, plugin.repository));
  if (plugin.license) addFact("License", plugin.license);
  if (plugin.metadata?.version) addFact("Version", plugin.metadata.version);
  if (plugin.compatibility) {
    const ranges: string[] = [];
    if (plugin.compatibility.bitty)
      ranges.push(`Bitty ${plugin.compatibility.bitty}`);
    if (plugin.compatibility.sdk)
      ranges.push(`SDK ${plugin.compatibility.sdk}`);
    if (ranges.length > 0) addFact("Compatibility", ranges.join(" · "));
  }
  if (plugin.categories && plugin.categories.length > 0) {
    addFact(
      "Categories",
      el(
        "span",
        {},
        ...plugin.categories.flatMap((category, index) => [
          index > 0 ? " · " : "",
          link(`/categories/${encodeURIComponent(category)}`, category),
        ]),
      ),
    );
  }
  if (plugin.tags && plugin.tags.length > 0) {
    addFact("Tags", plugin.tags.join(", "));
  }

  const node = el(
    "article",
    { class: "detail" },
    el(
      "p",
      { class: "breadcrumb" },
      link("/", "Directory"),
      ` / ${plugin.name}`,
    ),
    el("h1", {}, plugin.name),
    el(
      "p",
      { class: "badges" },
      badge(
        plugin.official ? "Official" : "Community",
        plugin.official ? "official" : "community",
      ),
      badge(kindLabel(plugin.kind)),
    ),
    plugin.description ? el("p", { class: "lede" }, plugin.description) : null,
    el(
      "section",
      { class: "install" },
      el("h2", {}, "Install"),
      el("pre", {}, el("code", {}, installCommand(plugin.id))),
      el(
        "p",
        { class: "note" },
        "The install command is a design proposal; the Bitty CLI does not implement registry installs yet.",
      ),
    ),
    el("section", {}, el("h2", {}, "Details"), facts),
  );
  return { title: `${plugin.name} · Bitty Plugins`, node };
}

function renderCategory(registry: Registry, category: string): View {
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

function renderAuthor(registry: Registry, author: string): View {
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

function renderSdk(): View {
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

function renderCreate(): View {
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

function renderNotFound(path: string): View {
  const node = el(
    "div",
    {},
    el("h1", {}, "Not found"),
    el("p", {}, `No route matches ${path}.`),
    el("p", {}, link("/", "Back to the directory")),
  );
  return { title: "Not found · Bitty Plugins", node };
}

export function renderView(registry: Registry, route: Route): View {
  switch (route.name) {
    case "home":
      return renderHome(registry);
    case "plugin":
      return renderPlugin(registry, route.id);
    case "category":
      return renderCategory(registry, route.category);
    case "author":
      return renderAuthor(registry, route.author);
    case "sdk":
      return renderSdk();
    case "create":
      return renderCreate();
    case "not-found":
      return renderNotFound(route.path);
  }
}

export function entrySummary(registry: Registry): string {
  return `${registry.plugins.length} entries · ${authorsOf(registry).length} authors · generated ${registry.generated_at}`;
}
