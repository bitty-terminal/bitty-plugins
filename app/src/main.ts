/**
 * Store bootstrap: load the generated index once, then render routes.
 */

import { loadRegistry, type Registry } from "./registry.ts";
import { installLinkInterceptor, parseRoute } from "./router.ts";
import { el, renderView } from "./views.ts";

const main = document.getElementById("main");

function renderError(message: string): void {
  if (!main) return;
  main.replaceChildren(
    el(
      "div",
      {},
      el("h1", {}, "Registry unavailable"),
      el("p", {}, message),
      el(
        "p",
        {},
        "The store reads generated/registry.json; run the producer and reload.",
      ),
    ),
  );
}

async function boot(): Promise<void> {
  if (!main) return;
  installLinkInterceptor();
  let registry: Registry;
  try {
    registry = await loadRegistry();
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
    return;
  }

  const render = (): void => {
    const route = parseRoute(location.pathname);
    const view = renderView(registry, route);
    document.title = view.title;
    main.replaceChildren(view.node);
    main.focus({ preventScroll: true });
  };

  addEventListener("popstate", render);
  render();
}

void boot();
