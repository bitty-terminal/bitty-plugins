/**
 * `<plugin-detail>` renders one registry entry's full page, including the
 * proposed install command.
 */

import { kindLabel, type Plugin, type PluginMetadata } from "../registry.ts";
import {
  badge,
  defineElement,
  el,
  externalLink,
  link,
  type Child,
} from "./dom.ts";
import "./install-command.ts";

function versionLabel(metadata: PluginMetadata | undefined): string | null {
  return metadata?.version ? `v${metadata.version}` : null;
}

export class PluginDetail extends HTMLElement {
  #plugin: Plugin | undefined;

  get plugin(): Plugin | undefined {
    return this.#plugin;
  }

  set plugin(value: Plugin | undefined) {
    this.#plugin = value;
    if (this.isConnected) this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const plugin = this.#plugin;
    if (!plugin) {
      this.replaceChildren();
      return;
    }

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
    const version = versionLabel(plugin.metadata);
    if (version) addFact("Version", version);
    if (plugin.compatibility) {
      const ranges: string[] = [];
      if (plugin.compatibility.bitty) {
        ranges.push(`Bitty ${plugin.compatibility.bitty}`);
      }
      if (plugin.compatibility.sdk) {
        ranges.push(`SDK ${plugin.compatibility.sdk}`);
      }
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
      plugin.description
        ? el("p", { class: "lede" }, plugin.description)
        : null,
      el(
        "section",
        { class: "install-section" },
        el("h2", {}, "Install"),
        el("install-command", { "plugin-id": plugin.id }),
      ),
      el("section", {}, el("h2", {}, "Details"), facts),
    );

    this.replaceChildren(node);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "plugin-detail": PluginDetail;
  }
}

defineElement("plugin-detail", PluginDetail);
