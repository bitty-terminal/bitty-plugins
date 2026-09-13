/**
 * Refresh optional manifest metadata in generated/registry.json.
 *
 * Fetches each plugin's `bitty-plugin.toml` over HTTPS with strict timeouts
 * and no credentials, then records the manifest's version, description, and
 * license under the plugin's optional `metadata` object. Offline runs, or runs
 * with `--skip-network` / REGISTRY_SKIP_NETWORK=1, leave the index unchanged
 * and exit zero with a notice.
 *
 * Usage:
 *   bun scripts/sync-metadata.ts [--skip-network]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATED_FILE,
  REPO_ROOT,
  buildIndex,
  countSeverity,
  formatDiagnostic,
  loadEntries,
  nowUtcSeconds,
  readIndexFile,
  renderIndex,
  validateEntry,
  validateRawKeys,
  validateRegistry,
  type Diagnostic,
  type IndexMetadata,
} from "./registry-lib.ts";

const FETCH_TIMEOUT_MS = 5000;
const FETCH_BUDGET_MS = 60000;

const USAGE = `usage: bun scripts/sync-metadata.ts [--skip-network]

Refreshes manifest metadata in ${GENERATED_FILE}.
  --skip-network   do not fetch anything (also REGISTRY_SKIP_NETWORK=1)
`;

/** Map a repository URL to its raw manifest URL, or null for unsupported hosts. */
export function rawManifestUrl(repository: string): string | null {
  try {
    const parsed = new URL(repository);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const owner = segments[0];
    const repo = segments[1];
    if (!owner || !repo) return null;
    if (
      parsed.hostname === "github.com" ||
      parsed.hostname === "www.github.com"
    ) {
      return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/bitty-plugin.toml`;
    }
    if (parsed.hostname === "gitlab.com") {
      return `https://gitlab.com/${owner}/${repo}/-/raw/HEAD/bitty-plugin.toml`;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 410) {
      throw Object.assign(
        new Error(`manifest not found (HTTP ${response.status})`),
        {
          missing: true,
        },
      );
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function manifestMetadata(
  text: string,
  source: string,
  previous: IndexMetadata | undefined,
  fetchedAt: string,
): IndexMetadata | null {
  let parsed: { plugin?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(text) as { plugin?: Record<string, unknown> };
  } catch (error) {
    console.log(
      `notice: ${source}: cannot parse bitty-plugin.toml (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
  const plugin = parsed.plugin;
  if (!plugin || typeof plugin !== "object") return null;
  const metadata: IndexMetadata = { source };
  if (typeof plugin.version === "string") metadata.version = plugin.version;
  if (typeof plugin.description === "string") {
    metadata.description = plugin.description;
  }
  if (typeof plugin.license === "string") metadata.license = plugin.license;
  if (metadata.version === undefined && metadata.license === undefined) {
    return null;
  }
  const unchanged =
    previous !== undefined &&
    previous.version === metadata.version &&
    previous.description === metadata.description &&
    previous.license === metadata.license &&
    previous.source === metadata.source;
  metadata.fetched_at =
    unchanged && previous.fetched_at ? previous.fetched_at : fetchedAt;
  return metadata;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const skipNetwork =
    args.includes("--skip-network") ||
    process.env.REGISTRY_SKIP_NETWORK === "1";
  if (skipNetwork) {
    console.log("notice: registry metadata sync skipped (--skip-network)");
    return 0;
  }

  const { entries, diagnostics: loadDiagnostics } = loadEntries();
  const diagnostics: Diagnostic[] = [...loadDiagnostics];
  for (const loaded of entries) {
    diagnostics.push(...validateRawKeys(loaded.raw, loaded.file));
    diagnostics.push(...validateEntry(loaded.entry, loaded.file));
  }
  diagnostics.push(...validateRegistry(entries));
  for (const diagnostic of diagnostics)
    console.log(formatDiagnostic(diagnostic));
  if (countSeverity(diagnostics, "error") > 0) {
    console.error(
      "error: registry validation failed; refusing to sync metadata",
    );
    return 1;
  }

  const previous = readIndexFile();
  if (!previous) {
    console.error(
      `error: ${GENERATED_FILE} is missing or malformed; run \`just registry-generate\` first`,
    );
    return 1;
  }
  const canonical = buildIndex(entries, previous);
  const metadataById = new Map<string, IndexMetadata>();
  const started = Date.now();
  let offline = false;
  let fetched = 0;

  for (const { entry, file } of entries) {
    if (offline) break;
    if (Date.now() - started > FETCH_BUDGET_MS) {
      console.log(
        "notice: fetch budget exhausted; skipping remaining metadata sync",
      );
      break;
    }
    const source = rawManifestUrl(entry.repository);
    if (source === null) {
      console.log(
        `notice: ${file}: manifest sync is not supported for this host; skipping`,
      );
      continue;
    }
    const existing = canonical.plugins.find(
      (plugin) => plugin.id === entry.id,
    )?.metadata;
    try {
      const text = await fetchText(source);
      const metadata = manifestMetadata(
        text,
        source,
        existing,
        nowUtcSeconds(),
      );
      fetched += 1;
      if (metadata) metadataById.set(entry.id, metadata);
    } catch (error) {
      if (error instanceof Error && "missing" in error) {
        console.log(`notice: ${file}: no bitty-plugin.toml found at ${source}`);
        continue;
      }
      offline = true;
      console.log(
        `notice: network unavailable (${error instanceof Error ? error.message : String(error)}); stopping metadata sync`,
      );
    }
  }

  const plugins = canonical.plugins.map((plugin) => {
    const metadata = metadataById.get(plugin.id);
    return metadata ? { ...plugin, metadata } : plugin;
  });
  const rendered = renderIndex({ ...canonical, plugins });
  const absolute = join(REPO_ROOT, GENERATED_FILE);
  const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  if (rendered === current) {
    console.log(`metadata unchanged (${fetched} manifest(s) fetched)`);
    return 0;
  }
  writeFileSync(absolute, rendered);
  console.log(
    `updated ${GENERATED_FILE} (${fetched} manifest(s) fetched, ${metadataById.size} metadata entr(ies))`,
  );
  return 0;
}

process.exit(await main());
