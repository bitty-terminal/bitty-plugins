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

export interface PluginSignature {
  algorithm: string;
  value: string;
  signer?: string;
}

/** Verification state carried by the index; absent means not verified. */
export type SignatureStatus = "verified" | "unverified" | "unsigned";

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
  manifest_hash?: string;
  signature?: PluginSignature;
  signature_status?: SignatureStatus;
  metadata?: PluginMetadata;
}

export interface Registry {
  schema_version: number;
  generated_at: string;
  plugins: Plugin[];
}

/**
 * Registry contract mirrors used for runtime re-validation. The store cannot
 * import the Node-side registry library (`scripts/registry-lib.ts`) because it
 * runs in the browser, so the id and repository formats are restated here and
 * must stay in sync with `registry/schema.json`.
 */
export const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const REPOSITORY_PATTERN =
  /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~-]+){2,}$/;
const SIGNATURE_STATUSES = new Set<SignatureStatus>([
  "verified",
  "unverified",
  "unsigned",
]);

export const KIND_LABELS: Record<string, string> = {
  plugin: "Plugin",
  theme: "Theme",
  skill: "Skill",
  harness: "Harness",
  mcp: "MCP server",
  integration: "Integration",
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isCompatibility(value: unknown): value is Compatibility {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.bitty !== undefined && typeof record.bitty !== "string") {
    return false;
  }
  if (record.sdk !== undefined && typeof record.sdk !== "string") {
    return false;
  }
  return true;
}

function isPluginMetadata(value: unknown): value is PluginMetadata {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && typeof record.version !== "string") {
    return false;
  }
  if (
    record.description !== undefined &&
    typeof record.description !== "string"
  ) {
    return false;
  }
  if (record.license !== undefined && typeof record.license !== "string") {
    return false;
  }
  if (record.source !== undefined && typeof record.source !== "string") {
    return false;
  }
  if (
    record.fetched_at !== undefined &&
    typeof record.fetched_at !== "string"
  ) {
    return false;
  }
  return true;
}

function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length > 64 ||
    !ID_PATTERN.test(record.id) ||
    typeof record.name !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.repository !== "string" ||
    !REPOSITORY_PATTERN.test(record.repository) ||
    typeof record.official !== "boolean"
  ) {
    return false;
  }
  if (record.author !== undefined && typeof record.author !== "string") {
    return false;
  }
  if (
    record.description !== undefined &&
    typeof record.description !== "string"
  ) {
    return false;
  }
  if (record.tags !== undefined && !isStringArray(record.tags)) {
    return false;
  }
  if (record.categories !== undefined && !isStringArray(record.categories)) {
    return false;
  }
  if (record.license !== undefined && typeof record.license !== "string") {
    return false;
  }
  if (
    record.compatibility !== undefined &&
    !isCompatibility(record.compatibility)
  ) {
    return false;
  }
  if (
    record.manifest_hash !== undefined &&
    typeof record.manifest_hash !== "string"
  ) {
    return false;
  }
  if (record.signature_status !== undefined) {
    if (
      typeof record.signature_status !== "string" ||
      !SIGNATURE_STATUSES.has(record.signature_status as SignatureStatus)
    ) {
      return false;
    }
  }
  if (record.metadata !== undefined && !isPluginMetadata(record.metadata)) {
    return false;
  }
  return true;
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
  if (id.length === 0 || id.length > 64 || !ID_PATTERN.test(id)) return "";
  return `bitty plugin add ${id}`;
}

/**
 * Allow only `https:` links from untrusted registry data. `javascript:`,
 * `data:`, `vbscript:`, and relative or malformed URLs are rejected so a
 * poisoned index cannot produce an active or scheme-confusing `href`.
 */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether the install command may be offered as a one-click copy.
 *
 * The decision depends only on client-side-verifiable facts: the id and
 * repository must match the registry patterns. `signature_status` is provided
 * by the same untrusted `generated/registry.json`, is not verified by the
 * client in this phase, and is displayed as an advisory badge only; it must
 * never gate the copy action, because a tampered index could set it to
 * `verified` without any signature check.
 */
export function isCopyAllowed(
  plugin: Pick<Plugin, "id" | "repository">,
): boolean {
  return (
    installCommand(plugin.id) !== "" &&
    REPOSITORY_PATTERN.test(plugin.repository)
  );
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}
