/**
 * Minimal, dependency-free semver range syntax validation.
 *
 * The accepted grammar is documented once, by `VERSION_RANGE_SYNTAX` below,
 * and every validator and diagnostic reuses that constant so the registry and
 * the plugin toolchain cannot describe different grammars. The structural
 * parser rejects malformed comparator shapes, empty `,`/`||` branches, and a
 * dangling `||`; hyphen ranges and build metadata are not supported. This
 * validator checks syntax only; it does not resolve ranges.
 */

/**
 * Canonical human-readable description of the accepted range grammar. This is
 * the single source for the grammar text; diagnostics interpolate it instead
 * of restating the syntax.
 */
export const VERSION_RANGE_SYNTAX =
  'comma-separated comparators joined by AND, `||` alternatives (OR), `*`, and the operators `^ ~ >= <= > < =` with 1-3 numeric segments and an optional prerelease suffix, for example ">=0.5,<1.0" or "^0.1"';

const COMPARATOR =
  /^(\^|~|>=|<=|>|<|=)?\s*(\d+)(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;

/**
 * Return null when `range` is structurally valid, otherwise a human-readable
 * description of the first structural problem found: an empty range, an empty
 * `||` alternative, an empty `,` comparator, or a malformed comparator. The
 * parser walks every AND/OR branch, so nonsense such as `>>>`, `|||`, a
 * leading or trailing `||`, or `1.0.0,,<2.0` is rejected here instead of
 * surviving to a downstream layer.
 */
export function versionRangeProblem(range: string): string | null {
  const trimmed = range.trim();
  if (trimmed.length === 0) return "range is empty";
  if (trimmed === "*") return null;
  const alternatives = trimmed.split("||");
  for (const [index, alternative] of alternatives.entries()) {
    const branch = alternative.trim();
    if (branch.length === 0) {
      return alternatives.length > 1
        ? `empty alternative ${index + 1} of ${alternatives.length} around "||"`
        : "range is empty";
    }
    for (const comparator of branch.split(",")) {
      const token = comparator.trim();
      if (token.length === 0) {
        return `empty comparator in "${branch}" around ","`;
      }
      if (!COMPARATOR.test(token)) {
        return `"${token}" is not a comparator`;
      }
    }
  }
  return null;
}

/** Boolean wrapper over `versionRangeProblem` for callers that only gate. */
export function isValidVersionRange(range: string): boolean {
  return versionRangeProblem(range) === null;
}
