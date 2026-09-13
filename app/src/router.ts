/**
 * Minimal History API router for the static store.
 *
 * Every route is served by the single Vite bundle. `app/public/_redirects`
 * declares the Cloudflare Pages SPA fallback (`/* /index.html 200`), which
 * Cloudflare applies only when no static asset matches the request.
 */

export type Route =
  | { name: "home" }
  | { name: "plugin"; id: string }
  | { name: "category"; category: string }
  | { name: "author"; author: string }
  | { name: "sdk" }
  | { name: "create" }
  | { name: "not-found"; path: string };

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter(Boolean).map(decodeSegment);
  const [first, second] = segments;
  if (first === undefined) return { name: "home" };
  if (first === "plugins" && second !== undefined) {
    return { name: "plugin", id: second };
  }
  if (first === "categories" && second !== undefined) {
    return { name: "category", category: second };
  }
  if (first === "authors" && second !== undefined) {
    return { name: "author", author: second };
  }
  if (first === "sdk") return { name: "sdk" };
  if (first === "create-plugin") return { name: "create" };
  return { name: "not-found", path: pathname };
}

export function navigate(path: string): void {
  if (path === `${location.pathname}${location.search}${location.hash}`) return;
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function installLinkInterceptor(): void {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[data-link]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    navigate(`${url.pathname}${url.search}${url.hash}`);
  });
}
