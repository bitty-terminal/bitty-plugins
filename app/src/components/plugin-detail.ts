/**
 * `<plugin-detail>` renders one registry entry's full page, including the
 * proposed install command.
 */

import {
  isCopyAllowed,
  kindLabel,
  type Plugin,
  type PluginMetadata,
} from "../registry.ts";
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

/**
 * Advisory signature label. `signature_status` comes from the index and is
 * not verified by the client in this phase, so the text stays descriptive and
 * never asserts a verification the client did not perform.
 */
function signatureLabel(plugin: Plugin): string {
  switch (plugin.signature_status) {
    case "verified":
      return "Index claims verified";
    case "unverified":
      return "Signature declared";
    default:
      return "Unsigned";
  }
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

    const copyAllowed = isCopyAllowed(plugin);
    const signatureVerified = plugin.signature_status === "verified";

    const node = el(
      "article",
      { class: signatureVerified ? "detail" : "detail detail-unverified" },
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
        badge(
          signatureLabel(plugin),
          signatureVerified ? "verified" : "unverified",
        ),
      ),
      plugin.description
        ? el("p", { class: "lede" }, plugin.description)
        : null,
      el(
        "section",
        { class: "install-section" },
        el("h2", {}, "Install"),
        copyAllowed
          ? el("install-command", { "plugin-id": plugin.id })
          : el(
              "p",
              { class: "note" },
              "This entry has an invalid id or repository; no install command is available.",
            ),
      ),
      signatureVerified
        ? null
        : el(
            "p",
            { class: "note" },
            "Signature verification is not implemented in this phase; integrity fields are advisory index data, not locally verified.",
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
