/**
 * Validate every registry entry.
 *
 * Checks: schema shape and key policy, duplicate ids, community file naming,
 * repository URL format and (bounded, network-guarded) existence, local
 * official-plugin manifest consistency, optional SDK manifest tooling, SPDX
 * license syntax, and compatibility range syntax. Exits non-zero when any
 * error is found; warnings alone do not fail.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  countSeverity,
  formatDiagnostic,
  loadEntries,
  repositoryName,
  validateEntry,
  validateRawKeys,
  validateRegistry,
  type Diagnostic,
  type LoadedEntry,
} from "./registry-lib.ts";

const NETWORK_TIMEOUT_MS = 5000;
const SDK_TIMEOUT_MS = 20000;
const SDK_INSTALL_TIMEOUT_MS = 120000;

const USAGE = `usage: bun scripts/validate-registry.ts [--skip-network]

Validates registry/official/*.toml and registry/community/*.toml.
  --skip-network   skip repository existence checks (also REGISTRY_SKIP_NETWORK=1)
`;

function skipNetworkRequested(args: string[]): boolean {
  return (
    args.includes("--skip-network") || process.env.REGISTRY_SKIP_NETWORK === "1"
  );
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded repository existence checks that stop at the first offline signal. */
async function checkRepositoriesOnline(
  entries: LoadedEntry[],
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  let offline = false;
  for (const { entry, file } of entries) {
    if (offline) break;
    if (!entry.repository.startsWith("https://")) continue;
    try {
      const response = await fetchWithTimeout(entry.repository);
      if (response.status === 404 || response.status === 410) {
        diagnostics.push({
          severity: "error",
          file,
          message: `repository not found (HTTP ${response.status}): ${entry.repository}`,
        });
      } else if (response.status >= 400) {
        diagnostics.push({
          severity: "warning",
          file,
          message: `repository returned HTTP ${response.status}: ${entry.repository}`,
        });
      }
    } catch (error) {
      offline = true;
      console.log(
        `notice: network unavailable (${error instanceof Error ? error.message : String(error)}); skipping remaining repository existence checks`,
      );
    }
  }
  return diagnostics;
}

interface ParsedManifest {
  plugin?: { id?: unknown; name?: unknown; license?: unknown };
}

/** Compare local official-plugin manifests with their registry entries. */
function checkLocalManifests(entries: LoadedEntry[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sdkCli = discoverSdkCli();
  const sdkReady = sdkCli !== null && ensureSdkDependencies();
  if (sdkCli !== null && sdkReady) {
    console.log(
      `notice: using SDK manifest tooling at ${sdkCli.slice(REPO_ROOT.length + 1)}`,
    );
  } else if (existsSync(join(REPO_ROOT, "sdk", "package.json"))) {
    console.log(
      "notice: SDK manifest tooling is unavailable (no bin entry or dependencies unavailable); skipping SDK lint",
    );
  }

  for (const { entry, file, official } of entries) {
    if (!official) continue;
    const name = repositoryName(entry.repository);
    if (name.length === 0) continue;
    const manifestPath = join(REPO_ROOT, "plugins", name, "bitty-plugin.toml");
    if (!existsSync(manifestPath)) continue;

    let manifest: ParsedManifest;
    try {
      manifest = Bun.TOML.parse(
        readFileSync(manifestPath, "utf8"),
      ) as ParsedManifest;
    } catch (error) {
      diagnostics.push({
        severity: "error",
        file,
        message: `cannot parse plugins/${name}/bitty-plugin.toml: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const manifestId = manifest.plugin?.id;
    if (typeof manifestId === "string" && manifestId !== entry.id) {
      diagnostics.push({
        severity: "error",
        file,
        message: `registry id "${entry.id}" does not match manifest plugins/${name}/bitty-plugin.toml plugin.id "${manifestId}"`,
      });
    }
    const manifestName = manifest.plugin?.name;
    if (typeof manifestName === "string" && manifestName !== entry.name) {
      diagnostics.push({
        severity: "warning",
        file,
        message: `registry name "${entry.name}" differs from manifest plugin.name "${manifestName}"`,
      });
    }
    const manifestLicense = manifest.plugin?.license;
    if (
      typeof manifestLicense === "string" &&
      entry.license !== undefined &&
      manifestLicense !== entry.license
    ) {
      diagnostics.push({
        severity: "warning",
        file,
        message: `registry license "${entry.license}" differs from manifest plugin.license "${manifestLicense}"`,
      });
    }

    if (sdkCli !== null && sdkReady) {
      const result = Bun.spawnSync({
        cmd: ["bun", sdkCli, manifestPath],
        stdout: "pipe",
        stderr: "pipe",
        timeout: SDK_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        diagnostics.push({
          severity: "error",
          file,
          message: `SDK manifest lint failed for plugins/${name}/bitty-plugin.toml${stderr.length > 0 ? `: ${stderr}` : ""}`,
        });
      }
    }
  }
  return diagnostics;
}

/**
 * Ensure the SDK tooling's dependencies are installed before invoking it.
 * Installs with the SDK lockfile when `sdk/node_modules` is missing; offline
 * installs fail soft so the SDK lint is skipped with a notice.
 */
function ensureSdkDependencies(): boolean {
  const sdkDir = join(REPO_ROOT, "sdk");
  if (!existsSync(join(sdkDir, "package.json"))) return false;
  if (existsSync(join(sdkDir, "node_modules"))) return true;
  console.log(
    "notice: installing SDK tooling dependencies (sdk/node_modules missing)",
  );
  const result = Bun.spawnSync({
    cmd: ["bun", "install", "--frozen-lockfile"],
    cwd: sdkDir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: SDK_INSTALL_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim().slice(0, 200);
    console.log(
      `notice: SDK dependency install failed; skipping SDK manifest lint${stderr.length > 0 ? ` (${stderr})` : ""}`,
    );
    return false;
  }
  return true;
}

/** Discover an SDK CLI entry point from sdk/package.json `bin` when present. */
function discoverSdkCli(): string | null {
  const packagePath = join(REPO_ROOT, "sdk", "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
      bin?: unknown;
    };
    if (typeof pkg.bin === "string") return join(REPO_ROOT, "sdk", pkg.bin);
    if (pkg.bin !== null && typeof pkg.bin === "object") {
      for (const value of Object.values(pkg.bin as Record<string, unknown>)) {
        if (typeof value === "string") return join(REPO_ROOT, "sdk", value);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function printDiagnostics(
  diagnostics: Diagnostic[],
  errors: number,
  warnings: number,
): void {
  const sorted = [...diagnostics].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.severity.localeCompare(b.severity) ||
      a.message.localeCompare(b.message),
  );
  for (const diagnostic of sorted) {
    console.log(formatDiagnostic(diagnostic));
  }
  console.log(
    `registry validation: ${errors} error(s), ${warnings} warning(s)`,
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const skipNetwork = skipNetworkRequested(args);
  const { entries, diagnostics: loadDiagnostics } = loadEntries();
  const diagnostics: Diagnostic[] = [...loadDiagnostics];
  for (const loaded of entries) {
    diagnostics.push(...validateRawKeys(loaded.raw, loaded.file));
    diagnostics.push(...validateEntry(loaded.entry, loaded.file));
  }
  diagnostics.push(...validateRegistry(entries));
  diagnostics.push(...checkLocalManifests(entries));
  if (skipNetwork) {
    console.log("notice: repository existence checks skipped (--skip-network)");
  } else {
    diagnostics.push(...(await checkRepositoriesOnline(entries)));
  }
  const errors = countSeverity(diagnostics, "error");
  const warnings = countSeverity(diagnostics, "warning");
  printDiagnostics(diagnostics, errors, warnings);
  return errors === 0 ? 0 : 1;
}

process.exit(await main());
