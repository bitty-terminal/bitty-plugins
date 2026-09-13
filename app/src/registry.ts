/**
 * Registry index types and read helpers.
 *
 * The store consumes only `/registry.json`, which `vite.config.ts` serves in
 * development and emits beside `index.html` at build time from the repository
 * artifact `generated/registry.json`. All values are treated as untrusted
 * display data.
 */

export interface Compatibility {
  bitty?: string;
  sdk?: string;
}

export interface PluginMetadata {
  version?: string;
  description?: string;
  license?: string;
  source?: string;
  fetched_at?: string;
}

export interface Plugin {
  id: string;
  name: string;
  kind: string;
  repository: string;
  official: boolean;
  author?: string;
  description?: string;
  tags?: string[];
  categories?: string[];
  license?: string;
  compatibility?: Compatibility;
  metadata?: PluginMetadata;
}

export interface Registry {
  schema_version: number;
  generated_at: string;
  plugins: Plugin[];
}

export const KIND_LABELS: Record<string, string> = {
  plugin: "Plugin",
  theme: "Theme",
  skill: "Skill",
  harness: "Harness",
  mcp: "MCP server",
  integration: "Integration",
};

function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.kind === "string" &&
    typeof record.repository === "string" &&
    typeof record.official === "boolean"
  );
}

export function isRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.schema_version === "number" &&
    typeof record.generated_at === "string" &&
    Array.isArray(record.plugins) &&
    record.plugins.every(isPlugin)
  );
}

export async function loadRegistry(): Promise<Registry> {
  const response = await fetch("/registry.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`registry.json unavailable (HTTP ${response.status})`);
  }
  const data: unknown = await response.json();
  if (!isRegistry(data)) {
    throw new Error("registry.json has an unexpected shape");
  }
  return data;
}

export function pluginById(registry: Registry, id: string): Plugin | undefined {
  return registry.plugins.find((plugin) => plugin.id === id);
}

export function pluginsByCategory(
  registry: Registry,
  category: string,
): Plugin[] {
  return registry.plugins.filter((plugin) =>
    plugin.categories?.includes(category),
  );
}

export function pluginsByAuthor(registry: Registry, author: string): Plugin[] {
  return registry.plugins.filter((plugin) => plugin.author === author);
}

export function categoriesOf(registry: Registry): string[] {
  const categories = new Set<string>();
  for (const plugin of registry.plugins) {
    for (const category of plugin.categories ?? []) categories.add(category);
  }
  return [...categories].sort();
}

export function authorsOf(registry: Registry): string[] {
  const authors = new Set<string>();
  for (const plugin of registry.plugins) {
    if (plugin.author) authors.add(plugin.author);
  }
  return [...authors].sort();
}

export function kindsOf(registry: Registry): string[] {
  const kinds = new Set<string>();
  for (const plugin of registry.plugins) kinds.add(plugin.kind);
  return [...kinds].sort();
}

export function installCommand(id: string): string {
  return `bitty plugin add ${id}`;
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}
