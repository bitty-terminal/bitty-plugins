/**
 * `<plugin-filters>` renders the kind, category, and official/community
 * controls and emits a `plugin-filters` event whenever one changes.
 *
 * `categories` and `kinds` are set as properties before the element is
 * inserted; `render` only runs once per connection in that flow.
 */

import { kindLabel } from "../registry.ts";
import { defineElement, el, uniqueId } from "./dom.ts";

export type PluginScope = "all" | "official" | "community";

export interface PluginFiltersDetail {
  kind: string;
  category: string;
  scope: PluginScope;
}

export class PluginFilters extends HTMLElement {
  #categories: string[] = [];
  #kinds: string[] = [];

  get categories(): string[] {
    return this.#categories;
  }

  set categories(value: string[]) {
    this.#categories = value;
    if (this.isConnected) this.render();
  }

  get kinds(): string[] {
    return this.#kinds;
  }

  set kinds(value: string[]) {
    this.#kinds = value;
    if (this.isConnected) this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    if (!this.isConnected) return;

    const kindId = uniqueId("plugin-filter-kind");
    const categoryId = uniqueId("plugin-filter-category");
    const scopeId = uniqueId("plugin-filter-scope");

    const kind = el(
      "select",
      { id: kindId, name: "kind" },
      el("option", { value: "" }, "All kinds"),
      ...this.#kinds.map((value) => el("option", { value }, kindLabel(value))),
    );
    const category = el(
      "select",
      { id: categoryId, name: "category" },
      el("option", { value: "" }, "All categories"),
      ...this.#categories.map((value) => el("option", { value }, value)),
    );
    const scope = el(
      "select",
      { id: scopeId, name: "scope" },
      el("option", { value: "all" }, "Official and community"),
      el("option", { value: "official" }, "Official only"),
      el("option", { value: "community" }, "Community only"),
    );

    const dispatch = (): void => {
      this.dispatchEvent(
        new CustomEvent<PluginFiltersDetail>("plugin-filters", {
          detail: {
            kind: kind.value,
            category: category.value,
            scope: scope.value as PluginScope,
          },
          bubbles: true,
          composed: true,
        }),
      );
    };
    for (const control of [kind, category, scope]) {
      control.addEventListener("change", dispatch);
    }

    this.replaceChildren(
      el(
        "div",
        { class: "filters" },
        el(
          "div",
          { class: "filter" },
          el("label", { for: kindId }, "Kind"),
          kind,
        ),
        el(
          "div",
          { class: "filter" },
          el("label", { for: categoryId }, "Category"),
          category,
        ),
        el(
          "div",
          { class: "filter" },
          el("label", { for: scopeId }, "Source"),
          scope,
        ),
      ),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "plugin-filters": PluginFilters;
  }
}

defineElement("plugin-filters", PluginFilters);
