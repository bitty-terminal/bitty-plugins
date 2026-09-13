/**
 * Minimal, dependency-free semver range syntax validation.
 *
 * Supported syntax: comma-separated comparator sets (AND), `||` alternatives
 * (OR), `*`, and the operators `^ ~ >= <= > < =` with 1-3 numeric segments and
 * an optional prerelease suffix. Hyphen ranges and build metadata are not
 * supported. This validator checks syntax only; it does not resolve ranges.
 */

const COMPARATOR =
  /^(\^|~|>=|<=|>|<|=)?\s*(\d+)(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;

export function isValidVersionRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "*") return true;
  const alternatives = trimmed.split("||");
  return alternatives.every((alternative) => {
    const trimmedAlternative = alternative.trim();
    if (trimmedAlternative.length === 0) return false;
    return trimmedAlternative
      .split(",")
      .every((comparator) => COMPARATOR.test(comparator.trim()));
  });
}
