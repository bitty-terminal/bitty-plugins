/**
 * `<install-command>` renders the proposed `bitty plugin add <id>` command
 * with a copy control. The command is a design proposal; the label says so.
 *
 * The plugin id is set through the `plugin-id` attribute or the `pluginId`
 * property.
 */

import { installCommand } from "../registry.ts";
import { defineElement, el } from "./dom.ts";

export class InstallCommand extends HTMLElement {
  static readonly observedAttributes = ["plugin-id"];

  #pluginId = "";
  #status: HTMLElement | undefined;
  #button: HTMLButtonElement | undefined;

  get pluginId(): string {
    return this.#pluginId;
  }

  set pluginId(value: string) {
    this.#pluginId = value;
    if (this.isConnected) this.render();
  }

  attributeChangedCallback(
    _name: string,
    _previous: string | null,
    value: string | null,
  ): void {
    this.#pluginId = value ?? "";
    if (this.isConnected) this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const command = installCommand(this.#pluginId);
    this.#status = el("p", {
      class: "copy-status",
      role: "status",
      "aria-live": "polite",
    });
    this.#button = el(
      "button",
      { type: "button", class: "copy-button" },
      "Copy",
    );

    this.#button.addEventListener("click", () => {
      void this.copy(command);
    });

    if (typeof navigator.clipboard?.writeText !== "function") {
      this.#button.disabled = true;
      this.#status.textContent =
        "Clipboard unavailable; select the command manually.";
    }

    this.replaceChildren(
      el(
        "div",
        { class: "command" },
        el("pre", {}, el("code", {}, command)),
        this.#button,
      ),
      this.#status,
      el(
        "p",
        { class: "note" },
        "The install command is a design proposal; the Bitty CLI does not implement registry installs yet.",
      ),
    );
  }

  private async copy(command: string): Promise<void> {
    const status = this.#status;
    try {
      await navigator.clipboard.writeText(command);
      if (status) status.textContent = "Copied to clipboard.";
    } catch {
      if (status)
        status.textContent = "Copy failed; select the command manually.";
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "install-command": InstallCommand;
  }
}

defineElement("install-command", InstallCommand);
