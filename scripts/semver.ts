/**
 * Minimal, dependency-free semver range syntax validation.
 *
 * Two grammars are modeled here:
 *
 * - The registry `[compatibility]` grammar enforced by `versionRangeProblem`
 *   and described by `VERSION_RANGE_SYNTAX`: comma-separated comparators with
 *   the operators `^ ~ >= <= > < =`, 1-3 numeric segments, and an optional
 *   prerelease suffix. Wildcard `*`, `||` disjunction, hyphen ranges, build
 *   metadata, and ranges over the byte budget are rejected, so the registry
 *   and the plugin toolchain cannot describe different grammars.
 * - The host resolver's closed grammar (`bitty-package`
 *   `crates/bitty-package/src/requirement.rs`, package-followup RFC
 *   §Constraint grammar), mirrored by `resolverRangeProblem` so registry
 *   validation can report accepted ranges the resolver could not parse. The
 *   mirror covers the parser budgets too (128-byte range, 64-byte version,
 *   u32 components, 16 comparators) and is regression-tested against the
 *   resolver probe evidence recorded for CTX-0016 under `recording/ctx-0016/`.
 *   It is a reporting aid, not the validator; the CTX-0016 findings and the
 *   pending full alignment are documented in the repository README section
 *   "Version range validation".
 *
 * The structural parser checks syntax only; it does not resolve ranges.
 */

/**
 * Canonical human-readable description of the accepted range grammar. This is
 * the single source for the grammar text; diagnostics interpolate it instead
 * of restating the syntax.
 */
export const VERSION_RANGE_SYNTAX =
  'comma-separated comparators joined by AND and the operators `^ ~ >= <= > < =` with 1-3 numeric segments and an optional prerelease suffix, for example ">=0.5,<1.0" or "^0.1"; wildcard `*`, `||` disjunction, and build metadata are not accepted, and a range is at most 128 bytes';

/**
 * Maximum range length in UTF-8 bytes. The host resolver and the SDK mock
 * host both fail closed above this budget (package-followup RFC §Constraint
 * grammar), so the registry validator enforces the same bound.
 */
export const MAX_VERSION_RANGE_BYTES = 128;

/** Per-version byte budget of the host resolver (`MAX_VERSION_LEN`). */
export const MAX_RESOLVER_VERSION_BYTES = 64;

/** Comparator-count budget of the host resolver (`MAX_COMPARATORS`). */
export const MAX_RESOLVER_COMPARATORS = 16;

/** Largest numeric version component the resolver parses (u32). */
const MAX_VERSION_COMPONENT = 4294967295n;

const COMPARATOR =
  /^(\^|~|>=|<=|>|<|=)?\s*(\d+)(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;

/** Strict `X.Y.Z` version accepted in resolver comparators. */
const RESOLVER_COMPARATOR_VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z._-]+))?(?:\+([0-9A-Za-z._-]+))?$/;

/** 1-3 segment shorthand accepted after resolver `^`/`~` operators. */
const RESOLVER_SHORTHAND_VERSION =
  /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z._-]+))?(?:\+([0-9A-Za-z._-]+))?$/;

/** UTF-8 byte length, matching the host resolver's `str::len()` bound. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Pad a caret/tilde shorthand core to `X.Y.Z`, mirroring the resolver's
 * `normalize_version_str` (`requirement.rs`). The resolver applies its
 * 64-byte version budget to the normalized text it parses, so `^1.2-<long>`
 * is measured as `1.2.0-<long>`, not as the raw shorthand.
 */
function normalizeShorthandVersion(version: string): string {
  const separatorAt = version.search(/[-+]/);
  const core = separatorAt === -1 ? version : version.slice(0, separatorAt);
  const suffix = separatorAt === -1 ? "" : version.slice(separatorAt);
  const segments = core.split(".");
  while (segments.length < 3) segments.push("0");
  return segments.join(".") + suffix;
}

/**
 * Return null when `range` is structurally valid, otherwise a human-readable
 * description of the first structural problem found: an empty range, an
 * overlong range, wildcard `*`, `||` disjunction, an empty `,` comparator, or
 * a malformed comparator. The parser walks every AND branch, so nonsense such
 * as `>>>`, a leading or trailing `|`, or `1.0.0,,<2.0` is rejected here
 * instead of surviving to a downstream layer.
 */
export function versionRangeProblem(range: string): string | null {
  const trimmed = range.trim();
  if (trimmed.length === 0) return "range is empty";
  if (byteLength(range) > MAX_VERSION_RANGE_BYTES) {
    return `range exceeds ${MAX_VERSION_RANGE_BYTES} bytes`;
  }
  if (trimmed.includes("|")) {
    return "disjunction '||' is not supported";
  }
  if (trimmed.includes("*")) {
    return "wildcard '*' is not supported";
  }
  for (const comparator of trimmed.split(",")) {
    const token = comparator.trim();
    if (token.length === 0) {
      return `empty comparator in "${trimmed}" around ","`;
    }
    if (!COMPARATOR.test(token)) {
      return `"${token}" is not a comparator`;
    }
  }
  return null;
}

/** Boolean wrapper over `versionRangeProblem` for callers that only gate. */
export function isValidVersionRange(range: string): boolean {
  return versionRangeProblem(range) === null;
}

/**
 * Return null when `range` is inside the closed grammar accepted by the host
 * resolver (`bitty-package`), otherwise a human-readable reason. The rules
 * mirror the resolver parser, confirmed case by case against the probe
 * evidence recorded for CTX-0016 under `recording/ctx-0016/`:
 *
 * - comparators require strict `X.Y.Z` versions (no partial `>=2.30`/`0.1`);
 * - `^`/`~` accept 1-3 segment shorthand but cannot combine with `,`;
 * - prerelease/build identifiers must be non-empty with resolver-legal
 *   characters, and numeric prerelease identifiers must not have a leading
 *   zero;
 * - core components must be digits without leading zeros and within u32;
 * - comparator and shorthand versions are capped at 64 bytes, ranges at 128
 *   bytes, and a comparator list at 16 comparators.
 *
 * Registry validation reports a warning for accepted ranges this function
 * rejects instead of failing them, because every official entry and plugin
 * manifest currently uses partial comparator versions that the resolver
 * rejects; rejecting them here would break the existing corpus. Full
 * convergence is the pending CTX-0016 decision.
 */
export function resolverRangeProblem(range: string): string | null {
  const trimmed = range.trim();
  if (trimmed.length === 0) return "range is empty";
  if (byteLength(range) > MAX_VERSION_RANGE_BYTES) {
    return `range exceeds the resolver's ${MAX_VERSION_RANGE_BYTES}-byte budget`;
  }
  const caretLike = trimmed.startsWith("^") || trimmed.startsWith("~");
  if (caretLike && trimmed.includes(",")) {
    return "caret/tilde ranges must not combine with ',' comparators";
  }
  const alternatives = trimmed.split(",");
  if (!caretLike && alternatives.length > MAX_RESOLVER_COMPARATORS) {
    return `more than ${MAX_RESOLVER_COMPARATORS} comparators`;
  }
  for (const alternative of alternatives) {
    const token = alternative.trim();
    if (token.length === 0) return "empty comparator";
    if (caretLike) {
      const problem = resolverVersionProblem(token.slice(1).trim(), true);
      if (problem !== null) return `${token}: ${problem}`;
      continue;
    }
    const match = /^(?:>=|<=|>|<|=)?\s*(.*)$/.exec(token);
    const version = (match?.[1] ?? "").trim();
    const problem = resolverVersionProblem(version, false);
    if (problem !== null) return `${token}: ${problem}`;
  }
  return null;
}

function resolverVersionProblem(
  version: string,
  shorthand: boolean,
): string | null {
  const sized = shorthand ? normalizeShorthandVersion(version) : version;
  if (byteLength(sized) > MAX_RESOLVER_VERSION_BYTES) {
    return `version exceeds the resolver's ${MAX_RESOLVER_VERSION_BYTES}-byte budget`;
  }
  const pattern = shorthand
    ? RESOLVER_SHORTHAND_VERSION
    : RESOLVER_COMPARATOR_VERSION;
  const match = pattern.exec(version);
  if (match === null) {
    return shorthand
      ? "resolver caret/tilde versions allow 1-3 numeric segments with optional prerelease/build metadata"
      : "resolver comparators require a strict X.Y.Z version";
  }
  for (const component of match.slice(1, 4)) {
    if (component === undefined) continue;
    if (component.length > 1 && component.startsWith("0")) {
      return `leading zero in "${component}"`;
    }
    if (BigInt(component) > MAX_VERSION_COMPONENT) {
      return `version component "${component}" exceeds u32`;
    }
  }
  const prerelease = match[4];
  if (prerelease !== undefined) {
    const problem = resolverIdentifierProblem(prerelease, "prerelease", true);
    if (problem !== null) return problem;
  }
  const build = match[5];
  if (build !== undefined) {
    const problem = resolverIdentifierProblem(build, "build", false);
    if (problem !== null) return problem;
  }
  return null;
}

function resolverIdentifierProblem(
  text: string,
  label: "prerelease" | "build",
  numericLeadingZero: boolean,
): string | null {
  for (const identifier of text.split(".")) {
    if (identifier.length === 0) {
      return `${label} identifier must not be empty`;
    }
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) {
      return `${label} identifier "${identifier}" contains an invalid character`;
    }
    if (
      numericLeadingZero &&
      /^\d+$/.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith("0")
    ) {
      return `${label} numeric identifier "${identifier}" must not have a leading zero`;
    }
  }
  return null;
}
