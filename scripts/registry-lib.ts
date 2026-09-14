/**
 * Shared registry model, loading, validation, and rendering helpers.
 *
 * The registry source of truth is `registry/**\/*.toml`; the only generated
 * artifact today is `generated/registry.json`. Consumers (the store frontend
 * and any future CLI) read the generated index only.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isValidVersionRange } from "./semver.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const REGISTRY_DIR = "registry";
export const OFFICIAL_DIR = "official";
export const COMMUNITY_DIR = "community";
export const GENERATED_FILE = "generated/registry.json";
export const SCHEMA_FILE = "registry/schema.json";

export const SCHEMA_VERSION = 1;

export const KINDS = [
  "plugin",
  "theme",
  "skill",
  "harness",
  "mcp",
  "integration",
] as const;
export type Kind = (typeof KINDS)[number];

export const DEFAULT_KIND: Kind = "plugin";

export const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COMMUNITY_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+\.toml$/;
export const REPOSITORY_PATTERN =
  /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~-]+){2,}$/;

export interface Compatibility {
  bitty?: string;
  sdk?: string;
}

export interface RegistryEntry {
  id: string;
  name: string;
  repository: string;
  kind: Kind;
  author?: string;
  description?: string;
  tags?: string[];
  categories?: string[];
  license?: string;
  compatibility?: Compatibility;
}

export interface IndexMetadata {
  version?: string;
  description?: string;
  license?: string;
  source?: string;
  fetched_at?: string;
}

export interface IndexPlugin {
  id: string;
  name: string;
  kind: Kind;
  repository: string;
  official: boolean;
  author?: string;
  description?: string;
  tags?: string[];
  categories?: string[];
  license?: string;
  compatibility?: Compatibility;
  metadata?: IndexMetadata;
}

export interface RegistryIndex {
  schema_version: number;
  generated_at: string;
  plugins: IndexPlugin[];
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  file: string;
  message: string;
}

export interface LoadedEntry {
  file: string;
  official: boolean;
  entry: RegistryEntry;
  raw: Record<string, unknown>;
}

export interface LoadResult {
  entries: LoadedEntry[];
  diagnostics: Diagnostic[];
}

const ENTRY_KEYS = new Set([
  "id",
  "name",
  "repository",
  "kind",
  "author",
  "description",
  "tags",
  "categories",
  "license",
  "compatibility",
]);

const COMPATIBILITY_KEYS = new Set(["bitty", "sdk"]);

export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.file}: ${diagnostic.severity}: ${diagnostic.message}`;
}

export function countSeverity(
  diagnostics: Diagnostic[],
  severity: Severity,
): number {
  return diagnostics.filter((d) => d.severity === severity).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** List entry files for one registry area, deterministically sorted. */
function listEntryFiles(area: string): { file: string; official: boolean }[] {
  const dir = join(REPO_ROOT, REGISTRY_DIR, area);
  if (!existsSync(dir)) return [];
  const official = area === OFFICIAL_DIR;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".toml"))
    .sort()
    .map((name) => ({
      file: `${REGISTRY_DIR}/${area}/${name}`,
      official,
    }));
}

/** Parse a TOML entry file into a raw object. */
export function parseEntryFile(file: string): {
  value?: Record<string, unknown>;
  diagnostic?: Diagnostic;
} {
  const absolute = join(REPO_ROOT, file);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    return {
      diagnostic: {
        severity: "error",
        file,
        message: `cannot read entry file: ${String(error)}`,
      },
    };
  }
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        diagnostic: {
          severity: "error",
          file,
          message: "entry must be a TOML table",
        },
      };
    }
    return { value: parsed };
  } catch (error) {
    return {
      diagnostic: {
        severity: "error",
        file,
        message: `invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/** Load every registry entry with parse diagnostics. */
export function loadEntries(): LoadResult {
  const entries: LoadedEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const files = [
    ...listEntryFiles(OFFICIAL_DIR),
    ...listEntryFiles(COMMUNITY_DIR),
  ];
  for (const { file, official } of files) {
    const { value, diagnostic } = parseEntryFile(file);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      continue;
    }
    if (!value) continue;
    entries.push({ file, official, entry: normalizeEntry(value), raw: value });
  }
  return { entries, diagnostics };
}

function normalizeEntry(value: Record<string, unknown>): RegistryEntry {
  const entry: RegistryEntry = {
    id: typeof value.id === "string" ? value.id : "",
    name: typeof value.name === "string" ? value.name : "",
    repository: typeof value.repository === "string" ? value.repository : "",
    // Invalid kind values are kept as declared so validation can report them;
    // the index is only built after validation passes.
    kind: typeof value.kind === "string" ? (value.kind as Kind) : DEFAULT_KIND,
  };
  if (typeof value.author === "string") entry.author = value.author;
  if (typeof value.description === "string") {
    entry.description = value.description;
  }
  if (isStringArray(value.tags)) entry.tags = [...value.tags];
  if (isStringArray(value.categories)) entry.categories = [...value.categories];
  if (typeof value.license === "string") entry.license = value.license;
  if (isPlainObject(value.compatibility)) {
    const compatibility: Compatibility = {};
    if (typeof value.compatibility.bitty === "string") {
      compatibility.bitty = value.compatibility.bitty;
    }
    if (typeof value.compatibility.sdk === "string") {
      compatibility.sdk = value.compatibility.sdk;
    }
    if (Object.keys(compatibility).length > 0) {
      entry.compatibility = compatibility;
    }
  }
  return entry;
}

/** Validate one entry against the accepted registry contract. */
export function validateEntry(
  entry: RegistryEntry,
  file: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string): void => {
    diagnostics.push({ severity: "error", file, message });
  };

  if (entry.id.length === 0) {
    error("missing required field `id`");
  } else if (!ID_PATTERN.test(entry.id) || entry.id.length > 64) {
    error(
      "`id` must be lowercase segments separated by `.`, `_`, or `-` (max 64 chars)",
    );
  }

  if ((KINDS as readonly string[]).includes(entry.kind) === false) {
    error(`\`kind\` must be one of: ${KINDS.join(", ")}`);
  }

  if (entry.name.length === 0) {
    error("missing required field `name`");
  } else if (entry.name.length > 80) {
    error("`name` must be at most 80 characters");
  }

  if (entry.repository.length === 0) {
    error("missing required field `repository`");
  } else if (!REPOSITORY_PATTERN.test(entry.repository)) {
    error(
      "`repository` must be an HTTPS repository URL without query, fragment, or credentials",
    );
  }

  if (entry.author !== undefined && !SLUG_PATTERN.test(entry.author)) {
    error("`author` must be a lowercase handle like `bitty-terminal`");
  }

  if (entry.description !== undefined) {
    if (entry.description.trim().length === 0) {
      error("`description` must not be empty");
    } else if (entry.description.length > 200) {
      error("`description` must be at most 200 characters");
    }
  }

  validateSlugArray(entry.tags, "tags", file, diagnostics);
  validateSlugArray(entry.categories, "categories", file, diagnostics);

  if (entry.license !== undefined) {
    const { error: licenseError, warnings } = checkLicense(entry.license);
    if (licenseError) error(`\`license\`: ${licenseError}`);
    for (const warning of warnings) {
      diagnostics.push({
        severity: "warning",
        file,
        message: `\`license\`: ${warning}`,
      });
    }
  }

  if (entry.compatibility) {
    for (const [key, range] of Object.entries(entry.compatibility)) {
      if (!COMPATIBILITY_KEYS.has(key)) {
        error(`\`compatibility.${key}\` is not a supported key`);
        continue;
      }
      if (!isValidVersionRange(range)) {
        error(
          `\`compatibility.${key}\` is not a valid semver range (for example ">=0.5,<1.0" or "^0.1")`,
        );
      }
    }
  }

  return diagnostics;
}

function validateSlugArray(
  values: string[] | undefined,
  field: string,
  file: string,
  diagnostics: Diagnostic[],
): void {
  if (values === undefined) return;
  const seen = new Set<string>();
  for (const value of values) {
    if (!SLUG_PATTERN.test(value) || value.length > 32) {
      diagnostics.push({
        severity: "error",
        file,
        message: `\`${field}\` entries must be lowercase slugs (max 32 chars): "${value}"`,
      });
    }
    if (seen.has(value)) {
      diagnostics.push({
        severity: "error",
        file,
        message: `\`${field}\` contains duplicate value "${value}"`,
      });
    }
    seen.add(value);
  }
}

/** Reject undeclared keys, including derived metadata and reserved fields. */
export function validateRawKeys(
  value: Record<string, unknown>,
  file: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const key of Object.keys(value)) {
    if (ENTRY_KEYS.has(key)) continue;
    if (key === "official") {
      diagnostics.push({
        severity: "error",
        file,
        message:
          "`official` is derived from the entry location and must not be declared",
      });
      continue;
    }
    if (
      ["version", "stars", "downloads", "created_at", "updated_at"].includes(
        key,
      )
    ) {
      diagnostics.push({
        severity: "error",
        file,
        message: `\`${key}\` is derived metadata and must not be declared; see scripts/sync-metadata.ts`,
      });
      continue;
    }
    diagnostics.push({
      severity: "error",
      file,
      message: `unknown key \`${key}\` (see registry/schema.json)`,
    });
  }
  if (isPlainObject(value.compatibility)) {
    for (const key of Object.keys(value.compatibility)) {
      if (!COMPATIBILITY_KEYS.has(key)) {
        diagnostics.push({
          severity: "error",
          file,
          message: `unknown key \`compatibility.${key}\``,
        });
      }
    }
  }
  return diagnostics;
}

// Common SPDX identifiers; the list is intentionally conservative and unknown
// identifiers only warn, so valid but unlisted licenses are not blocked.
const KNOWN_SPDX_IDS = new Set([
  "0BSD",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-3-Clause-Clear",
  "BSL-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC0-1.0",
  "EPL-2.0",
  "EUPL-1.2",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "NCSA",
  "OpenSSL",
  "PostgreSQL",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
]);

const SPDX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/** Validate an SPDX expression; returns hard errors and advisory warnings. */
export function checkLicense(expression: string): {
  error?: string;
  warnings: string[];
} {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return { error: "must not be empty", warnings: [] };
  }
  const tokens = trimmed.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { error: "not a valid SPDX expression", warnings: [] };
  }
  const identifiers: string[] = [];
  let expectIdentifier = true;
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "WITH") {
      if (expectIdentifier) {
        return {
          error: `operator "${token}" must follow an identifier`,
          warnings: [],
        };
      }
      expectIdentifier = true;
      continue;
    }
    if (!SPDX_ID_PATTERN.test(token)) {
      return {
        error: `"${token}" is not a valid SPDX identifier or operator`,
        warnings: [],
      };
    }
    if (!expectIdentifier) {
      return {
        error: `missing operator before "${token}"`,
        warnings: [],
      };
    }
    identifiers.push(token);
    expectIdentifier = false;
  }
  if (expectIdentifier) {
    return { error: "expression must not end with an operator", warnings: [] };
  }
  const warnings = identifiers
    .filter((id) => !KNOWN_SPDX_IDS.has(id) && !id.startsWith("LicenseRef-"))
    .map(
      (id) =>
        `"${id}" is not in the bundled common SPDX list; verify it is a real identifier`,
    );
  return { warnings };
}

/** Duplicate and file-convention checks across all loaded entries. */
export function validateRegistry(entries: LoadedEntry[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map<string, string>();
  for (const { entry, file } of entries) {
    const previous = byId.get(entry.id);
    if (previous !== undefined) {
      diagnostics.push({
        severity: "error",
        file,
        message: `duplicate id "${entry.id}" (already declared in ${previous})`,
      });
    } else if (entry.id.length > 0) {
      byId.set(entry.id, file);
    }
    if (!file.startsWith(`${REGISTRY_DIR}/${COMMUNITY_DIR}/`)) continue;
    const name = basename(file);
    if (!COMMUNITY_FILE_PATTERN.test(name)) {
      diagnostics.push({
        severity: "error",
        file,
        message:
          "community entry files must be named <author>-<slug>.toml (lowercase kebab-case, at least one hyphen)",
      });
    }
  }
  return diagnostics;
}

/** Repository basename, used to locate local submodule copies of official plugins. */
export function repositoryName(repository: string): string {
  try {
    const url = new URL(repository);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "";
  } catch {
    return "";
  }
}

export interface SubmoduleEntry {
  /** Submodule name from the `[submodule "<name>"]` header. */
  name: string;
  /** Declared checkout path, for example `plugins/activity`. */
  path: string;
  /** Declared clone URL. */
  url: string;
  /** Declared tracking branch, when present. */
  branch?: string;
}

/**
 * Parse `.gitmodules` INI content into submodule entries.
 *
 * Minimal hand-rolled parser (no new dependencies): only
 * `[submodule "..."]` sections with `path`, `url`, and optional `branch`
 * keys are collected; every other section or key is ignored. Never throws on
 * malformed input; sections missing `path` or `url` are dropped.
 */
export function parseGitmodules(text: string): SubmoduleEntry[] {
  const entries: SubmoduleEntry[] = [];
  let current: SubmoduleEntry | null = null;
  const push = (): void => {
    if (current !== null && current.path.length > 0 && current.url.length > 0) {
      entries.push(current);
    }
    current = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const section = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    const sectionName = section?.[1];
    if (sectionName !== undefined) {
      push();
      current = { name: sectionName, path: "", url: "" };
      continue;
    }
    if (line.startsWith("[")) {
      push();
      continue;
    }
    if (current === null) continue;
    const assignment = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
    const key = assignment?.[1];
    const value = assignment?.[2];
    if (key === undefined || value === undefined) continue;
    const unquoted = value
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    if (key === "path") current.path = unquoted;
    else if (key === "url") current.url = unquoted;
    else if (key === "branch") current.branch = unquoted;
  }
  push();
  return entries;
}

/**
 * Normalize a repository or submodule URL for comparison. Trailing slashes
 * and a trailing `.git` suffix are deployment details, not identity, so they
 * are ignored; everything else compares exactly.
 */
export function normalizeRepositoryUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/**
 * Static offline consistency checks between official registry entries and the
 * `plugins/` submodule pins declared in `.gitmodules`.
 *
 * (1) every official entry needs a `plugins/<name>` submodule, where `<name>`
 * is the repository basename; (2) the submodule URL must match the entry
 * `repository` field; (3) `plugins/<name>` submodules or directories with no
 * official entry are reported. Pure and offline: callers supply the parsed
 * `.gitmodules` entries and the observed `plugins/` directory names, so unit
 * tests never touch the filesystem or the network.
 */
export function checkSubmoduleConsistency(
  entries: LoadedEntry[],
  submodules: SubmoduleEntry[],
  pluginDirs: string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byPath = new Map<string, SubmoduleEntry>();
  for (const submodule of submodules) {
    if (!byPath.has(submodule.path)) byPath.set(submodule.path, submodule);
  }
  const claimed = new Set<string>();
  for (const { entry, file, official } of entries) {
    if (!official) continue;
    const name = repositoryName(entry.repository);
    if (name.length === 0) continue;
    claimed.add(name);
    const path = `plugins/${name}`;
    const submodule = byPath.get(path);
    if (submodule === undefined) {
      diagnostics.push({
        severity: "error",
        file,
        message: `official entry has no "${path}" submodule declared in .gitmodules`,
      });
      continue;
    }
    if (
      normalizeRepositoryUrl(submodule.url) !==
      normalizeRepositoryUrl(entry.repository)
    ) {
      diagnostics.push({
        severity: "error",
        file,
        message: `"${path}" submodule URL "${submodule.url}" does not match registry repository "${entry.repository}"`,
      });
    }
  }
  const candidates = new Set<string>();
  for (const submodule of submodules) {
    const rest = submodule.path.match(/^plugins\/([^/]+)$/)?.[1];
    if (rest !== undefined) candidates.add(rest);
  }
  for (const dir of pluginDirs) candidates.add(dir);
  for (const name of [...candidates].sort()) {
    if (!claimed.has(name)) {
      diagnostics.push({
        severity: "warning",
        file: "plugins/",
        message: `plugins/${name} has no official registry entry (add registry/official/${name}.toml or remove the directory)`,
      });
    }
  }
  return diagnostics;
}

/** Parse the generated index, returning null when missing or malformed. */
export function parseIndex(text: string): RegistryIndex | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return null;
    if (typeof parsed.schema_version !== "number") return null;
    if (typeof parsed.generated_at !== "string") return null;
    if (!Array.isArray(parsed.plugins)) return null;
    return parsed as unknown as RegistryIndex;
  } catch {
    return null;
  }
}

export function readIndexFile(): RegistryIndex | null {
  const absolute = join(REPO_ROOT, GENERATED_FILE);
  if (!existsSync(absolute)) return null;
  return parseIndex(readFileSync(absolute, "utf8"));
}

function sortedUnique(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return [...new Set(values)].sort();
}

/** Convert a loaded entry into its canonical index form. */
export function toIndexPlugin(
  entry: RegistryEntry,
  official: boolean,
  metadata?: IndexMetadata,
): IndexPlugin {
  const plugin: IndexPlugin = {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    repository: entry.repository,
    official,
  };
  if (entry.author !== undefined) plugin.author = entry.author;
  if (entry.description !== undefined) plugin.description = entry.description;
  const tags = sortedUnique(entry.tags);
  if (tags !== undefined) plugin.tags = tags;
  const categories = sortedUnique(entry.categories);
  if (categories !== undefined) plugin.categories = categories;
  if (entry.license !== undefined) plugin.license = entry.license;
  if (entry.compatibility !== undefined)
    plugin.compatibility = entry.compatibility;
  if (metadata !== undefined) plugin.metadata = metadata;
  return plugin;
}

function payloadEquals(a: IndexPlugin[], b: IndexPlugin[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function nowUtcSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build the generated index.
 *
 * Deterministic: plugins are sorted by id; optional arrays are sorted; the
 * `generated_at` timestamp is preserved when the plugin payload is unchanged so
 * regeneration is idempotent. `metadata` is preserved from the previous index
 * and refreshed only by scripts/sync-metadata.ts.
 */
export function buildIndex(
  entries: LoadedEntry[],
  previous: RegistryIndex | null,
  now: string = nowUtcSeconds(),
): RegistryIndex {
  const previousById = new Map<string, IndexPlugin>();
  for (const plugin of previous?.plugins ?? []) {
    previousById.set(plugin.id, plugin);
  }
  const plugins = entries
    .map(({ entry, official }) =>
      toIndexPlugin(entry, official, previousById.get(entry.id)?.metadata),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const generatedAt =
    previous && payloadEquals(previous.plugins, plugins)
      ? previous.generated_at
      : now;

  return { schema_version: SCHEMA_VERSION, generated_at: generatedAt, plugins };
}

/** Canonical JSON rendering (2-space indent, trailing newline, LF). */
export function renderIndex(index: RegistryIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
