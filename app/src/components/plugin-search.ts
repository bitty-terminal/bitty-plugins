/**
 * `<plugin-search>` renders the search field and emits a `plugin-search`
 * event with the current query. Consumers filter the registry themselves.
 */

import { defineElement, el, uniqueId } from "./dom.ts";

export interface PluginSearchDetail {
  query: string;
}

export class PluginSearch extends HTMLElement {
  #input: HTMLInputElement | undefined;

  connectedCallback(): void {
    if (this.#input) return;

    const id = uniqueId("plugin-search");
    const input = el("input", {
      type: "search",
      id,
      placeholder: "Search by name, id, tag, or author…",
      autocomplete: "off",
    });
    input.addEventListener("input", () => {
      this.dispatchEvent(
        new CustomEvent<PluginSearchDetail>("plugin-search", {
          detail: { query: input.value },
          bubbles: true,
          composed: true,
        }),
      );
    });
    this.#input = input;

    this.replaceChildren(
      el("div", { class: "search" }, el("label", { for: id }, "Search"), input),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "plugin-search": PluginSearch;
  }
}

defineElement("plugin-search", PluginSearch);
