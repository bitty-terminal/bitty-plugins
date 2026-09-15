/**
 * Refresh optional manifest metadata in generated/registry.json.
 *
 * Fetches each plugin's `bitty-plugin.toml` over HTTPS with strict timeouts,
 * no credentials, a hard 256 KiB body cap, and an identity check: the fetched
 * `plugin.id` must equal the registry entry's `id` before any metadata is
 * recorded. A mismatch is a hard error (the stale metadata is kept); an
 * oversized body is a warning (the stale metadata is kept). Offline runs, or
 * runs with `--skip-network` / REGISTRY_SKIP_NETWORK=1, leave the index
 * unchanged and exit zero with a notice.
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

/**
 * Hard cap on a fetched manifest body, mirroring the SDK manifest validator's
 * `MANIFEST_MAX_BYTES` (256 KiB). A larger response is rejected before its
 * bytes are decoded, and the entry keeps its previous metadata.
 */
export const MANIFEST_MAX_BYTES = 256 * 1024;

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
    return await readBoundedText(response);
  } finally {
    clearTimeout(timer);
  }
}

function oversizedError(limit: number, observed?: number): Error {
  const detail = observed === undefined ? "" : ` (${observed} bytes)`;
  return Object.assign(
    new Error(`manifest exceeds the ${limit}-byte limit${detail}`),
    { oversized: true },
  );
}

/**
 * Read a response body as text while enforcing a hard byte cap.
 *
 * A `Content-Length` pre-check rejects the declared oversize before any body
 * bytes are read; otherwise the stream is consumed incrementally and aborted
 * as soon as the running total exceeds the cap, so an oversized body is never
 * fully buffered or decoded. Exceeding the cap throws an error flagged with
 * `oversized: true`.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number = MANIFEST_MAX_BYTES,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel();
      throw oversizedError(maxBytes, length);
    }
  }

  const body = response.body;
  if (body === null) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > maxBytes) throw oversizedError(maxBytes, bytes);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw oversizedError(maxBytes, total);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** Result of reading a fetched manifest: metadata, a notice, or a hard error. */
export interface ManifestMetadataResult {
  metadata: IndexMetadata | null;
  error?: string;
  notice?: string;
}

/**
 * Extract manifest metadata, binding it to the expected registry id.
 *
 * The fetched manifest is untrusted: when its `plugin.id` is missing or does
 * not equal the registry entry's id, an error is returned and no metadata is
 * produced, so the caller keeps the entry's previous metadata instead of
 * hanging another plugin's version under this id.
 */
export function manifestMetadata(
  text: string,
  source: string,
  expectedId: string,
  previous: IndexMetadata | undefined,
  fetchedAt: string,
): ManifestMetadataResult {
  let parsed: { plugin?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(text) as { plugin?: Record<string, unknown> };
  } catch (error) {
    return {
      metadata: null,
      notice: `cannot parse bitty-plugin.toml (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const plugin = parsed.plugin;
  if (!plugin || typeof plugin !== "object") return { metadata: null };

  const manifestId = typeof plugin.id === "string" ? plugin.id : "";
  if (manifestId !== expectedId) {
    const observed =
      manifestId === "" ? "(missing plugin.id)" : `plugin.id "${manifestId}"`;
    return {
      metadata: null,
      error: `manifest identity mismatch: registry id "${expectedId}" but fetched ${observed}; refusing to record metadata`,
    };
  }

  const metadata: IndexMetadata = { source };
  if (typeof plugin.version === "string") metadata.version = plugin.version;
  if (typeof plugin.description === "string") {
    metadata.description = plugin.description;
  }
  if (typeof plugin.license === "string") metadata.license = plugin.license;
  if (metadata.version === undefined && metadata.license === undefined) {
    return { metadata: null };
  }
  const unchanged =
    previous !== undefined &&
    previous.version === metadata.version &&
    previous.description === metadata.description &&
    previous.license === metadata.license &&
    previous.source === metadata.source;
  metadata.fetched_at =
    unchanged && previous.fetched_at ? previous.fetched_at : fetchedAt;
  return { metadata };
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
  const syncDiagnostics: Diagnostic[] = [];
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
      const result = manifestMetadata(
        text,
        source,
        entry.id,
        existing,
        nowUtcSeconds(),
      );
      fetched += 1;
      if (result.notice) {
        console.log(`notice: ${file}: ${result.notice}`);
        continue;
      }
      if (result.error) {
        syncDiagnostics.push({
          severity: "error",
          file,
          message: result.error,
        });
        continue;
      }
      if (result.metadata) metadataById.set(entry.id, result.metadata);
    } catch (error) {
      if (error instanceof Error && "missing" in error) {
        console.log(`notice: ${file}: no bitty-plugin.toml found at ${source}`);
        continue;
      }
      if (error instanceof Error && "oversized" in error) {
        syncDiagnostics.push({
          severity: "warning",
          file,
          message: `${error.message}; keeping previous metadata`,
        });
        continue;
      }
      offline = true;
      console.log(
        `notice: network unavailable (${error instanceof Error ? error.message : String(error)}); stopping metadata sync`,
      );
    }
  }

  for (const diagnostic of syncDiagnostics) {
    console.log(formatDiagnostic(diagnostic));
  }
  const syncErrors = countSeverity(syncDiagnostics, "error");

  const plugins = canonical.plugins.map((plugin) => {
    const metadata = metadataById.get(plugin.id);
    return metadata ? { ...plugin, metadata } : plugin;
  });
  const rendered = renderIndex({ ...canonical, plugins });
  const absolute = join(REPO_ROOT, GENERATED_FILE);
  const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  const exitCode = syncErrors > 0 ? 1 : 0;
  if (rendered === current) {
    console.log(`metadata unchanged (${fetched} manifest(s) fetched)`);
    return exitCode;
  }
  writeFileSync(absolute, rendered);
  console.log(
    `updated ${GENERATED_FILE} (${fetched} manifest(s) fetched, ${metadataById.size} metadata entr(ies))`,
  );
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
