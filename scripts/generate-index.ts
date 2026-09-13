/**
 * Merge every registry entry into generated/registry.json deterministically.
 *
 * The index is sorted by id and idempotent: `generated_at` only changes when
 * the plugin payload changes, and `metadata` (populated by
 * scripts/sync-metadata.ts) is preserved across regenerations. Validation
 * errors abort the generation without writing.
 *
 * Usage:
 *   bun scripts/generate-index.ts          write the index
 *   bun scripts/generate-index.ts --check  fail when the index is stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  GENERATED_FILE,
  REPO_ROOT,
  buildIndex,
  countSeverity,
  formatDiagnostic,
  loadEntries,
  readIndexFile,
  renderIndex,
  validateEntry,
  validateRawKeys,
  validateRegistry,
  type Diagnostic,
} from "./registry-lib.ts";

const USAGE = `usage: bun scripts/generate-index.ts [--check]

Writes ${GENERATED_FILE} from registry/**/*.toml.
  --check   exit non-zero when the file is stale instead of writing
`;

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const check = args.includes("--check");

  const { entries, diagnostics: loadDiagnostics } = loadEntries();
  const diagnostics: Diagnostic[] = [...loadDiagnostics];
  for (const loaded of entries) {
    diagnostics.push(...validateRawKeys(loaded.raw, loaded.file));
    diagnostics.push(...validateEntry(loaded.entry, loaded.file));
  }
  diagnostics.push(...validateRegistry(entries));

  for (const diagnostic of diagnostics) {
    console.log(formatDiagnostic(diagnostic));
  }
  if (countSeverity(diagnostics, "error") > 0) {
    console.error(
      "error: registry validation failed; refusing to generate the index",
    );
    return 1;
  }

  const previous = readIndexFile();
  const index = buildIndex(entries, previous);
  const rendered = renderIndex(index);
  const absolute = join(REPO_ROOT, GENERATED_FILE);
  const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;

  if (current === rendered) {
    console.log(
      `${GENERATED_FILE} is up to date (${entries.length} plugin(s))`,
    );
    return 0;
  }
  if (check) {
    console.error(
      `error: ${GENERATED_FILE} is stale; run \`just registry-generate\``,
    );
    return 1;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, rendered);
  console.log(
    `wrote ${GENERATED_FILE} (${entries.length} plugin(s), generated_at ${index.generated_at})`,
  );
  return 0;
}

process.exit(main());
