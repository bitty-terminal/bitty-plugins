/**
 * Store bootstrap: load the generated index once, then render routes.
 */

import "./styles/main.css";
import {
  authorPage,
  categoryPage,
  createPage,
  homePage,
  notFoundPage,
  pluginPage,
  sdkPage,
  type Page,
} from "./pages.ts";
import { loadRegistry, pluginById, type Registry } from "./registry.ts";
import { installLinkInterceptor, parseRoute, type Route } from "./router.ts";

const main = document.getElementById("main");
const footer = document.querySelector("footer");

function reveal(): void {
  if (main) main.hidden = false;
  if (footer) footer.hidden = false;
}

function renderError(message: string): void {
  if (!main) return;
  main.replaceChildren();
  const container = document.createElement("div");
  const heading = document.createElement("h1");
  heading.textContent = "Registry unavailable";
  const detail = document.createElement("p");
  detail.textContent = message;
  const hint = document.createElement("p");
  hint.textContent =
    "The store reads generated/registry.json; run the producer and reload.";
  container.append(heading, detail, hint);
  main.appendChild(container);
}

function pageFor(registry: Registry, route: Route): Page {
  switch (route.name) {
    case "home":
      return homePage(registry);
    case "plugin": {
      const plugin = pluginById(registry, route.id);
      return plugin ? pluginPage(plugin) : notFoundPage(`/plugins/${route.id}`);
    }
    case "category":
      return categoryPage(registry, route.category);
    case "author":
      return authorPage(registry, route.author);
    case "sdk":
      return sdkPage();
    case "create":
      return createPage();
    case "not-found":
      return notFoundPage(route.path);
  }
}

async function boot(): Promise<void> {
  if (!main) return;
  installLinkInterceptor();

  // Reveal the shell only when the registry is ready (or after a short delay
  // on slow connections) so the first paint and the loaded page never shift.
  const loadingTimer = setTimeout(() => {
    main.hidden = false;
  }, 250);

  let registry: Registry;
  try {
    registry = await loadRegistry();
  } catch (error) {
    clearTimeout(loadingTimer);
    renderError(error instanceof Error ? error.message : String(error));
    reveal();
    return;
  }
  clearTimeout(loadingTimer);

  const render = (): void => {
    const page = pageFor(registry, parseRoute(location.pathname));
    document.title = page.title;
    main.replaceChildren(page.node);
    reveal();
    main.focus({ preventScroll: true });
  };

  addEventListener("popstate", render);
  render();
}

void boot();
