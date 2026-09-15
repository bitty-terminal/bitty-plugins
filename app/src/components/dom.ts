/**
 * Tiny DOM helpers shared by the store's custom elements.
 *
 * Registry values are untrusted display data: widgets always create text
 * nodes and attributes through this module, never `innerHTML`.
 */

import { isAllowedExternalUrl } from "../registry.ts";

export type Child = Node | string | null | undefined | false;

let nextId = 1;

export function uniqueId(prefix: string): string {
  const id = `${prefix}-${nextId}`;
  nextId += 1;
  return id;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : value);
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
}

export function link(path: string, label: string): HTMLAnchorElement {
  return el("a", { href: path, "data-link": true }, label);
}

/**
 * Render an external link. Only `https:` targets produce a real anchor; any
 * other scheme or malformed URL degrades to inert text, so a poisoned index
 * cannot smuggle `javascript:`/`data:` into `href`.
 */
export function externalLink(url: string, label: string): HTMLElement {
  if (!isAllowedExternalUrl(url)) {
    return el(
      "span",
      { class: "external-link-blocked", title: "Blocked non-HTTPS link" },
      label,
    );
  }
  return el(
    "a",
    { href: url, rel: "noopener noreferrer", target: "_blank" },
    label,
  );
}

export function badge(text: string, variant?: string): HTMLElement {
  return el(
    "span",
    { class: `badge${variant ? ` badge-${variant}` : ""}` },
    text,
  );
}

export function defineElement(
  name: string,
  constructor: CustomElementConstructor,
): void {
  if (!customElements.get(name)) customElements.define(name, constructor);
}
