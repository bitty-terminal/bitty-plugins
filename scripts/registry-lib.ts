/**
 * Shared registry model, loading, validation, and rendering helpers.
 *
 * The registry source of truth is `registry/**\/*.toml`; the only generated
 * artifact today is `generated/registry.json`. Consumers (the store frontend
 * and any future CLI) read the generated index only.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  VERSION_RANGE_SYNTAX,
  resolverRangeProblem,
  versionRangeProblem,
} from "./semver.ts";

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

// Integrity fields are optional in this phase: absence is a warning, never a
// validation error, because no verification keys are configured yet.
export const MANIFEST_HASH_PATTERN = /^[a-z0-9]+:[0-9a-f]{32,128}$/;
export const MANIFEST_HASH_MAX_LENGTH = 160;
export const SIGNATURE_ALGORITHM_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const SIGNATURE_ALGORITHM_MAX_LENGTH = 32;
export const SIGNATURE_VALUE_MAX_LENGTH = 4096;
export const SIGNATURE_SIGNER_MAX_LENGTH = 256;

/**
 * Registry compatibility ranges. A registry entry names the same two ranges a
 * plugin manifest declares under `[compat]`, but the keys differ: the registry
 * uses `sdk`, a manifest uses `plugin-api`. `COMPATIBILITY_MANIFEST_FIELDS`
 * below is the single in-repo record of that mapping.
 */
export interface Compatibility {
  bitty?: string;
  sdk?: string;
}

export interface RegistrySignature {
  algorithm: string;
  value: string;
  signer?: string;
}

/**
 * Verification state recorded in the generated index. `verified` is reserved
 * for a future key-configured phase; `unverified` means a signature is declared
 * but not checked, and `unsigned` means no signature is declared.
 */
export type SignatureStatus = "verified" | "unverified" | "unsigned";

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
  manifest_hash?: string;
  signature?: RegistrySignature;
}

export interface IndexMetadata {
  version?: string;
  description?: string;
  license?: string;
  source?: string;
  fetched_at?: string;
  repository_source?: string;
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
  manifest_hash?: string;
  signature?: RegistrySignature;
  signature_status: SignatureStatus;
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
  "manifest_hash",
  "signature",
]);

const COMPATIBILITY_KEYS = new Set(["bitty", "sdk"]);

/**
 * Mapping from registry compatibility keys to the plugin-manifest `[compat]`
 * fields that carry the same range. A registry entry declares
 * `compatibility.sdk`; the plugin's `bitty-plugin.toml` declares the identical
 * contract as `compat.plugin-api`. This table is the single in-repo record of
 * that dual-track naming: reviewers compare the two ranges against it when
 * either side moves, so a registry `sdk` bump that leaves the manifest
 * `plugin-api` range behind (or vice versa) is visible in the diff. The
 * registry performs no cross-repository fetch, so drift is surfaced by review
 * of this mapping plus the paired README table, never by a runtime comparison.
 */
export const COMPATIBILITY_MANIFEST_FIELDS = {
  bitty: "bitty",
  sdk: "plugin-api",
} as const satisfies Record<keyof Compatibility, string>;

/**
 * Keys that are recognized but deliberately unsupported at the registry layer
 * in this phase. Each produces an explicit error naming the decision instead
 * of the generic unknown-key message.
 *
 * `dependencies`: plugin manifests may declare `[dependencies]` (bounded and
 * self-dependency checked), but the registry has no cross-plugin dependency
 * model yet: no version intersection, no cycle detection, and no index field.
 * A registry entry that declares dependencies could not be resolved by an
 * installer, so it is rejected until that model is separately authorized and
 * approved. See the README "Dependency model" section.
 */
const UNSUPPORTED_ENTRY_KEYS = new Map<string, string>([
  [
    "dependencies",
    '`dependencies` is not supported in registry entries; declare plugin dependencies in the plugin manifest `bitty-plugin.toml` `[dependencies]` (see README "Dependency model"). The registry has no cross-plugin dependency model yet, so it cannot express or resolve dependency ranges.',
  ],
]);

const SIGNATURE_KEYS = new Set(["algorithm", "value", "signer"]);

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
    // Validate raw types before normalization (PLUG-REG-001)
    const typeErrors = validateRawEntryTypes(value, file);
    if (typeErrors.length > 0) {
      diagnostics.push(...typeErrors);
      continue;
    }
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
  if (typeof value.manifest_hash === "string") {
    entry.manifest_hash = value.manifest_hash;
  }
  if (isPlainObject(value.signature)) {
    const rawSignature = value.signature;
    const signature: RegistrySignature = {
      algorithm:
        typeof rawSignature.algorithm === "string"
          ? rawSignature.algorithm
          : "",
      value: typeof rawSignature.value === "string" ? rawSignature.value : "",
    };
    if (typeof rawSignature.signer === "string") {
      signature.signer = rawSignature.signer;
    }
    entry.signature = signature;
  }
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

/**
 * Validate raw entry types before normalization (PLUG-REG-001).
 *
 * The normalization step silently coerces wrong types to defaults, which can
 * mask validation errors. This function checks required and optional field
 * types against the schema before normalization runs, ensuring wrong types
 * are reported as errors rather than defaulted.
 */
function validateRawEntryTypes(
  value: Record<string, unknown>,
  file: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string): void => {
    diagnostics.push({ severity: "error", file, message });
  };

  // Required fields must be strings
  if (value.id !== undefined && typeof value.id !== "string") {
    error("`id` must be a string");
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    error("`name` must be a string");
  }
  if (value.repository !== undefined && typeof value.repository !== "string") {
    error("`repository` must be a string");
  }

  // Optional string fields
  if (value.kind !== undefined && typeof value.kind !== "string") {
    error("`kind` must be a string");
  }
  if (value.author !== undefined && typeof value.author !== "string") {
    error("`author` must be a string");
  }
  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    error("`description` must be a string");
  }
  if (value.license !== undefined && typeof value.license !== "string") {
    error("`license` must be a string");
  }
  if (
    value.manifest_hash !== undefined &&
    typeof value.manifest_hash !== "string"
  ) {
    error("`manifest_hash` must be a string");
  }

  // Array fields
  if (value.tags !== undefined && !isStringArray(value.tags)) {
    error("`tags` must be an array of strings");
  }
  if (value.categories !== undefined && !isStringArray(value.categories)) {
    error("`categories` must be an array of strings");
  }

  // Object fields
  if (value.signature !== undefined && !isPlainObject(value.signature)) {
    error("`signature` must be an object");
  }
  if (
    value.compatibility !== undefined &&
    !isPlainObject(value.compatibility)
  ) {
    error("`compatibility` must be an object");
  }

  // Nested signature fields (only if signature is an object)
  if (isPlainObject(value.signature)) {
    const sig = value.signature;
    if (sig.algorithm !== undefined && typeof sig.algorithm !== "string") {
      error("`signature.algorithm` must be a string");
    }
    if (sig.value !== undefined && typeof sig.value !== "string") {
      error("`signature.value` must be a string");
    }
    if (sig.signer !== undefined && typeof sig.signer !== "string") {
      error("`signature.signer` must be a string");
    }
  }

  // Nested compatibility fields (only if compatibility is an object)
  if (isPlainObject(value.compatibility)) {
    const compat = value.compatibility;
    if (compat.bitty !== undefined && typeof compat.bitty !== "string") {
      error("`compatibility.bitty` must be a string");
    }
    if (compat.sdk !== undefined && typeof compat.sdk !== "string") {
      error("`compatibility.sdk` must be a string");
    }
  }

  return diagnostics;
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

  validateIntegrityFields(entry, file, diagnostics);

  if (entry.compatibility) {
    for (const [key, range] of Object.entries(entry.compatibility)) {
      if (!COMPATIBILITY_KEYS.has(key)) {
        error(`\`compatibility.${key}\` is not a supported key`);
        continue;
      }
      const problem = versionRangeProblem(range);
      if (problem !== null) {
        error(
          `\`compatibility.${key}\` is not a valid semver range: ${problem} (${VERSION_RANGE_SYNTAX})`,
        );
        continue;
      }
      const resolverProblem = resolverRangeProblem(range);
      if (resolverProblem !== null) {
        diagnostics.push({
          severity: "warning",
          file,
          message: `\`compatibility.${key}\` range "${range}" is not accepted by the closed host resolver grammar: ${resolverProblem}; accepted for now, full alignment is pending (CTX-0016 / DEC-0008)`,
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Validate the optional integrity fields. A declared field is shape-checked
 * as a hard error; a missing field only warns, so unsigned entries remain
 * publishable while the ecosystem moves toward mandatory verification.
 */
function validateIntegrityFields(
  entry: RegistryEntry,
  file: string,
  diagnostics: Diagnostic[],
): void {
  const error = (message: string): void => {
    diagnostics.push({ severity: "error", file, message });
  };
  const warn = (message: string): void => {
    diagnostics.push({ severity: "warning", file, message });
  };

  if (entry.manifest_hash === undefined) {
    warn(
      "`manifest_hash` is not set; integrity binding is advisory in this phase (unsigned entries are accepted with a warning)",
    );
  } else if (
    !MANIFEST_HASH_PATTERN.test(entry.manifest_hash) ||
    entry.manifest_hash.length > MANIFEST_HASH_MAX_LENGTH
  ) {
    error(
      '`manifest_hash` must be an algorithm-prefixed lowercase hex digest like "sha256:<64 hex chars>"',
    );
  }

  const signature = entry.signature;
  if (signature === undefined) {
    warn(
      "`signature` is not set; the index records this entry as `unsigned` (unsigned entries are accepted with a warning in this phase)",
    );
    return;
  }
  if (
    !SIGNATURE_ALGORITHM_PATTERN.test(signature.algorithm) ||
    signature.algorithm.length > SIGNATURE_ALGORITHM_MAX_LENGTH
  ) {
    error(
      '`signature.algorithm` must be a lowercase scheme token like "ed25519" or "minisign"',
    );
  }
  if (signature.value.length === 0) {
    error("`signature.value` must not be empty");
  } else if (signature.value.length > SIGNATURE_VALUE_MAX_LENGTH) {
    error(
      `\`signature.value\` must be at most ${SIGNATURE_VALUE_MAX_LENGTH} characters`,
    );
  }
  if (
    signature.signer !== undefined &&
    (signature.signer.length === 0 ||
      signature.signer.length > SIGNATURE_SIGNER_MAX_LENGTH)
  ) {
    error(
      `\`signature.signer\` must be 1-${SIGNATURE_SIGNER_MAX_LENGTH} characters when present`,
    );
  }
}

function validateSlugArray(
  values: string[] | undefined,
  field: string,
  file: string,
  diagnostics: Diagnostic[],
): void {
  if (values === undefined) return;
  // Deduplicate case-insensitively and first: `["a", "A"]` is the same slug
  // repeated, so it is reported as a duplicate rather than as a casing error,
  // and the diagnostic does not depend on which casing appears first.
  const seen = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      diagnostics.push({
        severity: "error",
        file,
        message: `\`${field}\` contains duplicate value "${value}" (case-insensitive; first declared as "${previous}")`,
      });
      continue;
    }
    seen.set(key, value);
    if (!SLUG_PATTERN.test(value) || value.length > 32) {
      diagnostics.push({
        severity: "error",
        file,
        message: `\`${field}\` entries must be lowercase slugs (max 32 chars): "${value}"`,
      });
    }
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
    const unsupported = UNSUPPORTED_ENTRY_KEYS.get(key);
    if (unsupported !== undefined) {
      diagnostics.push({ severity: "error", file, message: unsupported });
      continue;
    }
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
  if (
    value.manifest_hash !== undefined &&
    typeof value.manifest_hash !== "string"
  ) {
    diagnostics.push({
      severity: "error",
      file,
      message: "`manifest_hash` must be a string",
    });
  }
  if (value.signature !== undefined && !isPlainObject(value.signature)) {
    diagnostics.push({
      severity: "error",
      file,
      message:
        "`signature` must be a table/object with `algorithm` and `value`",
    });
  }
  if (isPlainObject(value.signature)) {
    for (const field of ["algorithm", "value", "signer"] as const) {
      const fieldValue = value.signature[field];
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        diagnostics.push({
          severity: "error",
          file,
          message: `\`signature.${field}\` must be a string`,
        });
      }
    }
    for (const key of Object.keys(value.signature)) {
      if (!SIGNATURE_KEYS.has(key)) {
        diagnostics.push({
          severity: "error",
          file,
          message: `unknown key \`signature.${key}\``,
        });
      }
    }
  }
  return diagnostics;
}

// Common SPDX identifiers. The list is intentionally conservative and the
// policy is fail-closed: an identifier that is neither listed here nor a
// `LicenseRef-` custom reference is a hard error, so an unverified license can
// never reach the generated index. Add newly accepted identifiers here in a
// reviewed change; `LicenseRef-<name>` is the escape hatch for private terms.
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

// Well-known SPDX exception identifiers accepted after `WITH`. Kept small and
// explicit (the single source of truth for exceptions): an exception that is
// not listed here is a hard error. Extend in a reviewed change alongside
// `KNOWN_SPDX_IDS`.
const KNOWN_SPDX_EXCEPTIONS = new Set([
  "Classpath-exception-2.0",
  "GCC-exception-3.1",
  "LLVM-exception",
]);

const SPDX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/**
 * Validate balanced parentheses in an SPDX expression (PLUG-REG-014).
 * Returns an error message if parentheses are unbalanced, null otherwise.
 */
function validateBalancedParentheses(expression: string): string | null {
  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === "(") {
      depth++;
    } else if (expression[i] === ")") {
      depth--;
      if (depth < 0) {
        return "unmatched closing parenthesis";
      }
    }
  }
  if (depth > 0) {
    return "unmatched opening parenthesis";
  }
  return null;
}

/**
 * Tokenize SPDX expression preserving parentheses (PLUG-REG-014).
 * Splits on whitespace but keeps parentheses as separate tokens.
 */
function tokenizeSpdxExpression(expression: string): string[] {
  const tokens: string[] = [];
  let current = "";

  for (let i = 0; i < expression.length; i++) {
    const char = expression.charAt(i);

    if (char === "(" || char === ")") {
      if (current.trim().length > 0) {
        tokens.push(current.trim());
        current = "";
      }
      tokens.push(char);
    } else if (/\s/.test(char)) {
      if (current.trim().length > 0) {
        tokens.push(current.trim());
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current.trim().length > 0) {
    tokens.push(current.trim());
  }

  return tokens;
}

/** Validate an SPDX expression; returns hard errors and advisory warnings. */
export function checkLicense(expression: string): {
  error?: string;
  warnings: string[];
} {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return { error: "must not be empty", warnings: [] };
  }

  // First validate balanced parentheses (PLUG-REG-014)
  const parenError = validateBalancedParentheses(trimmed);
  if (parenError) {
    return { error: parenError, warnings: [] };
  }

  // Extract tokens while preserving parentheses as separate tokens
  const tokens = tokenizeSpdxExpression(trimmed);
  if (tokens.length === 0) {
    return { error: "not a valid SPDX expression", warnings: [] };
  }

  const licenses: string[] = [];
  const exceptions: string[] = [];
  let expectIdentifier = true;
  let expectException = false;
  let previousWasException = false;
  let depth = 0;

  for (const token of tokens) {
    // Handle parentheses
    if (token === "(") {
      if (!expectIdentifier) {
        return {
          error: "opening parenthesis must follow an operator or be at start",
          warnings: [],
        };
      }
      depth++;
      continue;
    }
    if (token === ")") {
      if (expectIdentifier) {
        return {
          error: "closing parenthesis cannot follow an operator",
          warnings: [],
        };
      }
      depth--;
      if (depth < 0) {
        return {
          error: "unmatched closing parenthesis",
          warnings: [],
        };
      }
      continue;
    }

    const upper = token.toUpperCase();
    if (upper === "AND" || upper === "OR") {
      if (expectIdentifier) {
        return {
          error: `operator "${token}" must follow an identifier`,
          warnings: [],
        };
      }
      expectIdentifier = true;
      expectException = false;
      previousWasException = false;
      continue;
    }
    if (upper === "WITH") {
      if (expectIdentifier) {
        return {
          error: `operator "${token}" must follow an identifier`,
          warnings: [],
        };
      }
      if (previousWasException) {
        return {
          error: '"WITH" cannot follow an exception identifier',
          warnings: [],
        };
      }
      expectIdentifier = true;
      expectException = true;
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
    if (expectException) {
      exceptions.push(token);
      expectException = false;
      previousWasException = true;
    } else {
      licenses.push(token);
      previousWasException = false;
    }
    expectIdentifier = false;
  }

  if (depth !== 0) {
    return { error: "unmatched opening parenthesis", warnings: [] };
  }
  if (expectIdentifier) {
    return { error: "expression must not end with an operator", warnings: [] };
  }
  const unknownLicenses = licenses.filter(
    (id) => !KNOWN_SPDX_IDS.has(id) && !id.startsWith("LicenseRef-"),
  );
  const unknownExceptions = exceptions.filter(
    (id) => !KNOWN_SPDX_EXCEPTIONS.has(id),
  );
  const problems: string[] = [];
  if (unknownLicenses.length > 0) {
    problems.push(
      `unknown SPDX license identifier(s) not in the bundled common list: ${unknownLicenses.join(", ")}`,
    );
  }
  if (unknownExceptions.length > 0) {
    problems.push(
      `unknown SPDX exception identifier(s) not in the bundled common list: ${unknownExceptions.join(", ")}`,
    );
  }
  if (problems.length > 0) {
    return {
      error: `${problems.join("; ")}; use a listed identifier or a LicenseRef- custom reference`,
      warnings: [],
    };
  }
  return { warnings: [] };
}

/** Duplicate and file-convention checks across all loaded entries. */
export function validateRegistry(entries: LoadedEntry[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map<string, string>();
  const byRepository = new Map<string, { id: string; file: string }>();
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
    if (entry.repository.length > 0) {
      const normalized = normalizeRepositoryUrl(entry.repository);
      const reused = byRepository.get(normalized);
      if (reused !== undefined && reused.id !== entry.id) {
        diagnostics.push({
          severity: "warning",
          file,
          message: `repository URL "${entry.repository}" is already used by id "${reused.id}" (${reused.file})`,
        });
      }
      if (reused === undefined) {
        byRepository.set(normalized, { id: entry.id, file });
      }
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

/**
 * Centralized repository URL identity mapping (PLUG-REG-004).
 *
 * Extracts owner and repository name from a repository URL, preserving
 * nested namespaces (e.g., gitlab.com/group/subgroup/repo). Returns null
 * for unsupported URL shapes.
 *
 * Supported patterns:
 * - github.com/owner/repo
 * - gitlab.com/owner/repo (or nested: group/subgroup/repo)
 * - Other hosts with at least owner/repo segments
 *
 * Returns { owner, repo, fullPath } where fullPath preserves all namespace
 * segments for hosts that support nesting.
 */
export interface RepositoryIdentity {
  /** First path segment (owner/organization) */
  owner: string;
  /** Last path segment (repository name) */
  repo: string;
  /** Full path preserving nested namespaces, e.g., "group/subgroup/repo" */
  fullPath: string;
  /** Hostname */
  host: string;
}

export function parseRepositoryIdentity(
  repository: string,
): RepositoryIdentity | null {
  try {
    const url = new URL(repository);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length < 2) {
      return null; // Need at least owner/repo
    }

    const owner = segments[0];
    const repo = segments[segments.length - 1];

    if (!owner || !repo) {
      return null; // Need at least owner and repo
    }

    const fullPath = segments.join("/");

    return {
      owner,
      repo,
      host: url.hostname,
      fullPath,
    };
  } catch {
    return null;
  }
}

/** Repository basename, used to locate local submodule copies of official plugins. */
export function repositoryName(repository: string): string {
  const identity = parseRepositoryIdentity(repository);
  return identity?.repo ?? "";
}

/** Where a local SDK checkout came from, in resolution precedence order. */
export type SdkSource = "env" | "submodule" | "sibling";

/** Resolved local SDK checkout and the reference that located it. */
export interface SdkDirResolution {
  dir: string;
  source: SdkSource;
}

/** Candidate SDK checkout locations, most explicit first. */
export interface SdkDirCandidates {
  /** Explicit override from `BITTY_PLUGIN_SDK_DIR`. */
  envDir?: string;
  /** In-repo submodule checkout, for example `<repo>/sdk`. */
  submoduleDir: string;
  /** Workspace-relative sibling checkouts, in preference order. */
  siblingDirs: string[];
}

/**
 * Resolve the SDK checkout directory: explicit environment override, then the
 * in-repo `sdk/` submodule, then workspace-relative sibling repositories.
 * `hasPackage` reports whether a directory holds the SDK `package.json`, so the
 * caller owns filesystem access and this stays pure for tests. Returns null
 * when no candidate exists; the caller then reports the gap rather than
 * silently skipping the SDK manifest lint.
 */
export function resolveSdkDir(
  candidates: SdkDirCandidates,
  hasPackage: (dir: string) => boolean,
): SdkDirResolution | null {
  const ordered: SdkDirResolution[] = [];
  const envDir = candidates.envDir?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    ordered.push({ dir: envDir, source: "env" });
  }
  ordered.push({ dir: candidates.submoduleDir, source: "submodule" });
  for (const dir of candidates.siblingDirs) {
    ordered.push({ dir, source: "sibling" });
  }
  return ordered.find((candidate) => hasPackage(candidate.dir)) ?? null;
}

/** Candidate local paths for one official plugin's manifest. */
export interface OfficialManifestCandidates {
  /** In-repo submodule checkout, for example `plugins/<name>/bitty-plugin.toml`. */
  submoduleManifest: string;
  /** Workspace-relative sibling repositories, in preference order. */
  siblingManifests: string[];
}

/**
 * Pick the first existing official manifest path, preferring the in-repo
 * submodule checkout over workspace-relative sibling repositories. Returns null
 * when nothing exists so the caller can report the coverage gap loudly instead
 * of silently passing an unchecked entry.
 */
export function resolveOfficialManifest(
  candidates: OfficialManifestCandidates,
  exists: (path: string) => boolean,
): string | null {
  return (
    [candidates.submoduleManifest, ...candidates.siblingManifests].find(
      (path) => exists(path),
    ) ?? null
  );
}

/**
 * Aggregate warning for official entries whose local manifest could not be
 * resolved. Returning a diagnostic (rather than letting the caller silently
 * `continue`) is what keeps an unverifiable official gate visible instead of
 * passing as an unchecked green. Returns null when nothing was unresolved.
 */
export function unresolvedOfficialManifestWarning(
  unresolved: string[],
): Diagnostic | null {
  if (unresolved.length === 0) return null;
  return {
    severity: "warning",
    file: "registry/",
    message: `official manifest checks skipped for ${unresolved.length} entr(ies) (${[...unresolved].sort().join(", ")}): no local checkout at plugins/<name> or the workspace sibling; initialize submodules or place the repositories in the workspace`,
  };
}

/** Entries whose repository URL can be checked over the network. */
export function countNetworkRepositories(entries: LoadedEntry[]): number {
  return entries.filter(({ entry }) => entry.repository.startsWith("https://"))
    .length;
}

/** Outcome of a tiered repository existence check. */
export interface RepositoryExistenceOutcome {
  diagnostics: Diagnostic[];
  /** Entries whose URL was checked (including 4xx/5xx responses). */
  checked: number;
  /** Entries left unchecked after a network error; zero when fully checked. */
  skipped: number;
  /** True when a network exception stopped the phase early. */
  offline: boolean;
}

/** Network access needed by the repository existence phase, injected for tests. */
export interface RepositoryExistencePorts {
  /** Request a repository URL; throw only to signal the network is unavailable. */
  check: (url: string) => Promise<{ status: number }>;
}

/**
 * Tiered repository existence checks.
 *
 * Every `https://` entry is checked in order. `404`/`410` are hard errors and
 * other `4xx`/`5xx` responses warn, because the host answered. A thrown network
 * error skips only the still-unchecked entries and reports the count through
 * `skipped`, so one timeout can never void the whole existence gate (the caller
 * decides how loudly to surface the gap). Pure apart from the injected port.
 */
export async function checkRepositoryExistence(
  entries: LoadedEntry[],
  ports: RepositoryExistencePorts,
): Promise<RepositoryExistenceOutcome> {
  const diagnostics: Diagnostic[] = [];
  const checkable = entries.filter(({ entry }) =>
    entry.repository.startsWith("https://"),
  );
  let checked = 0;
  let offline = false;
  for (const { entry, file } of checkable) {
    let status: number;
    try {
      ({ status } = await ports.check(entry.repository));
    } catch {
      offline = true;
      break;
    }
    checked += 1;
    if (status === 404 || status === 410) {
      diagnostics.push({
        severity: "error",
        file,
        message: `repository not found (HTTP ${status}): ${entry.repository}`,
      });
    } else if (status >= 400) {
      diagnostics.push({
        severity: "warning",
        file,
        message: `repository returned HTTP ${status}: ${entry.repository}`,
      });
    }
  }
  return {
    diagnostics,
    checked,
    skipped: checkable.length - checked,
    offline,
  };
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

/** An official plugin submodule pin resolved from the working tree. */
export interface OfficialPin {
  /** Plugin directory name, for example `activity` (`plugins/activity`). */
  name: string;
  /** Pinned commit SHA recorded by git for `plugins/<name>`. */
  pin: string;
  /** Registry `repository` URL of the official entry. */
  repository: string;
  /** Registry entry file, used for diagnostics. */
  file: string;
}

/**
 * Collect official pins that have a matching `plugins/<name>` submodule.
 * Entries without a submodule are skipped silently here: the offline mapping
 * check in `checkSubmoduleConsistency` already reports them, and the pin
 * check must not double-report.
 */
export function collectOfficialPins(
  entries: LoadedEntry[],
  submodules: SubmoduleEntry[],
): OfficialPin[] {
  const paths = new Set(submodules.map((submodule) => submodule.path));
  const pins: OfficialPin[] = [];
  for (const { entry, file, official } of entries) {
    if (!official) continue;
    const name = repositoryName(entry.repository);
    if (name.length === 0) continue;
    if (!paths.has(`plugins/${name}`)) continue;
    pins.push({ name, pin: "", repository: entry.repository, file });
  }
  return pins;
}

/** GitHub `owner/repo` slug parsed from a registry repository URL. */
export interface GitHubSlug {
  owner: string;
  repo: string;
}

/**
 * Parse a `https://github.com/<owner>/<repo>` repository URL into its slug.
 * Returns null for other hosts, short paths, and malformed URLs; a trailing
 * `.git` suffix on the repo segment is tolerated.
 */
export function githubRepoSlug(repository: string): GitHubSlug | null {
  try {
    const url = new URL(repository);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const owner = segments[0];
    const repo = segments[1];
    if (owner === undefined || repo === undefined || segments.length !== 2) {
      return null;
    }
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

/**
 * GitHub compare `status` values for `base...head`, where `base` is the
 * submodule pin and `head` is the default-branch tip.
 */
export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

/**
 * Decide whether a submodule pin is a mainline commit from a compare status.
 * `ahead` (the tip contains the pin) and `identical` (the pin is the tip)
 * prove the pin is an ancestor of the default branch; `behind` and
 * `diverged` prove it is not.
 */
export function isPinReachable(status: CompareStatus): boolean {
  return status === "ahead" || status === "identical";
}

export interface PinCheckRequest extends OfficialPin {}

/** Outcome of the bounded pin reachability phase. */
export interface PinCheckOutcome {
  diagnostics: Diagnostic[];
  /** Human-readable notices the caller prints (offline, skips, budgets). */
  notices: string[];
  /** True when the phase stopped early; later pins were not checked. */
  halted: boolean;
}

/**
 * Network and git access needed by the pin reachability phase, injected so
 * unit tests can stub every path (including offline) without I/O.
 */
export interface PinCheckPorts {
  /**
   * Resolve the default-branch tip SHA for a repository URL (for example via
   * `git ls-remote <url> HEAD`). Return null when the tip cannot be
   * determined; throw only to signal the network is unavailable.
   */
  resolveDefaultTip: (repository: string) => Promise<string | null>;
  /**
   * Compare a pin against the default-branch tip. Return the compare status,
   * or `httpStatus` for non-OK HTTP responses. Throw only to signal the
   * network is unavailable.
   */
  comparePinToTip: (
    slug: GitHubSlug,
    base: string,
    head: string,
  ) => Promise<{ status?: CompareStatus; httpStatus?: number }>;
}

/**
 * Bounded mainline reachability check over official submodule pins.
 *
 * For each pin, resolves the default-branch tip and compares `pin...tip`:
 * `ahead`/`identical` pass, `behind`/`diverged` and unknown pins (HTTP 404)
 * fail, other HTTP failures warn, unsupported hosts are skipped with a
 * notice, and the first offline signal halts the phase with a notice
 * (consistent with the existing repository existence guard). Exceeding
 * `budgetMs` also halts with a notice. Pure apart from the injected ports.
 */
export async function checkPinReachability(
  requests: PinCheckRequest[],
  ports: PinCheckPorts,
  budgetMs: number,
  started = Date.now(),
): Promise<PinCheckOutcome> {
  const diagnostics: Diagnostic[] = [];
  const notices: string[] = [];
  for (const request of requests) {
    if (Date.now() - started > budgetMs) {
      notices.push(
        "notice: pin reachability budget exhausted; skipping remaining pin checks",
      );
      return { diagnostics, notices, halted: true };
    }
    const slug = githubRepoSlug(request.repository);
    if (slug === null) {
      notices.push(
        `notice: ${request.file}: pin reachability is not supported for this host; skipping`,
      );
      continue;
    }
    let tip: string | null;
    try {
      tip = await ports.resolveDefaultTip(request.repository);
    } catch (error) {
      notices.push(
        `notice: network unavailable (${error instanceof Error ? error.message : String(error)}); skipping remaining pin reachability checks`,
      );
      return { diagnostics, notices, halted: true };
    }
    if (tip === null) {
      notices.push(
        `notice: network unavailable (cannot resolve default branch for ${request.repository}); skipping remaining pin reachability checks`,
      );
      return { diagnostics, notices, halted: true };
    }
    if (request.pin === tip) continue;
    let compared: { status?: CompareStatus; httpStatus?: number };
    try {
      compared = await ports.comparePinToTip(slug, request.pin, tip);
    } catch (error) {
      notices.push(
        `notice: network unavailable (${error instanceof Error ? error.message : String(error)}); skipping remaining pin reachability checks`,
      );
      return { diagnostics, notices, halted: true };
    }
    if (compared.status !== undefined) {
      if (!isPinReachable(compared.status)) {
        diagnostics.push({
          severity: "error",
          file: request.file,
          message: `plugins/${request.name} pin ${request.pin} is not reachable from the default branch (compare status "${compared.status}")`,
        });
      }
      continue;
    }
    if (compared.httpStatus === 404) {
      diagnostics.push({
        severity: "error",
        file: request.file,
        message: `plugins/${request.name} pin ${request.pin} was not found in ${request.repository}`,
      });
      continue;
    }
    diagnostics.push({
      severity: "warning",
      file: request.file,
      message: `pin reachability check for plugins/${request.name} returned HTTP ${compared.httpStatus ?? "unknown"}; skipping`,
    });
  }
  return { diagnostics, notices, halted: false };
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
    signature_status: entry.signature === undefined ? "unsigned" : "unverified",
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
  if (entry.manifest_hash !== undefined)
    plugin.manifest_hash = entry.manifest_hash;
  if (entry.signature !== undefined) plugin.signature = entry.signature;
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
    .map(({ entry, official }) => {
      const previousPlugin = previousById.get(entry.id);
      let metadata = previousPlugin?.metadata;
      // Invalidate metadata if repository has changed
      if (
        metadata?.repository_source !== undefined &&
        normalizeRepositoryUrl(metadata.repository_source) !==
          normalizeRepositoryUrl(entry.repository)
      ) {
        metadata = undefined;
      }
      return toIndexPlugin(entry, official, metadata);
    })
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
