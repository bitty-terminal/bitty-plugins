/**
 * `<plugin-card>` renders one registry entry as a summary card.
 */

import { kindLabel, type Plugin } from "../registry.ts";
import { badge, defineElement, el, link } from "./dom.ts";

export class PluginCard extends HTMLElement {
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

    const node = el(
      "article",
      { class: "card" },
      el(
        "h2",
        { class: "card-title" },
        link(`/plugins/${encodeURIComponent(plugin.id)}`, plugin.name),
      ),
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
        ? el("p", { class: "card-description" }, plugin.description)
        : null,
      el(
        "p",
        { class: "card-meta" },
        el("code", {}, plugin.id),
        plugin.metadata?.version ? ` · v${plugin.metadata.version}` : "",
        plugin.license ? ` · ${plugin.license}` : "",
      ),
      plugin.tags && plugin.tags.length > 0
        ? el(
            "ul",
            { class: "chips", "aria-label": "Tags" },
            ...plugin.tags.map((tag) => el("li", {}, tag)),
          )
        : null,
    );

    this.replaceChildren(node);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "plugin-card": PluginCard;
  }
}

defineElement("plugin-card", PluginCard);
