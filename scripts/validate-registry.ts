/**
 * Validate every registry entry.
 *
 * Checks: schema shape and key policy, duplicate ids, community file naming,
 * repository URL format and (bounded, network-guarded) existence, local
 * official-plugin manifest consistency, official entry to plugins/ submodule
 * mapping and pin presence (static, offline), submodule pin mainline
 * reachability and manifest hash binding (bounded, network-guarded), optional
 * SDK manifest tooling, SPDX license syntax, and compatibility range syntax.
 * Exits non-zero when any error is found; warnings alone do not fail.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  REPO_ROOT,
  MANIFEST_MAX_BYTES,
  NON_SHIPPING_PIN_EXEMPTIONS,
  PLUGIN_MANIFEST_FILE,
  checkManifestHashes,
  checkPinReachability,
  checkRepositoryExistence,
  checkSubmoduleConsistency,
  countNetworkRepositories,
  countSeverity,
  formatDiagnostic,
  isOversizedManifestError,
  loadEntries,
  parseGitmodules,
  planPinChecks,
  readBoundedBytes,
  readManifestFromCheckout,
  readPinnedManifest,
  readSubmodulePins,
  repositoryName,
  resolveOfficialManifest,
  resolveSdkDir,
  unresolvedOfficialManifestWarning,
  validateEntry,
  validateRawKeys,
  validateRegistry,
  type CompareStatus,
  type Diagnostic,
  type GitHubSlug,
  type LoadedEntry,
  type LocalManifestRead,
  type ManifestHashRequest,
  type ManifestReadResult,
  type SdkDirResolution,
  type SubmoduleEntry,
} from "./registry-lib.ts";

const NETWORK_TIMEOUT_MS = 5000;
const SDK_TIMEOUT_MS = 20000;
const SDK_INSTALL_TIMEOUT_MS = 120000;
const PIN_COMPARE_TIMEOUT_MS = 10000;
const PIN_LS_REMOTE_TIMEOUT_MS = 15000;
const PIN_MANIFEST_TIMEOUT_MS = 10000;
const PIN_CHECK_BUDGET_MS = 60000;

/** Explicit override for the SDK checkout used by the manifest lint. */
const SDK_ENV_VAR = "BITTY_PLUGIN_SDK_DIR";
/** Marker that identifies the flat workspace root holding sibling repositories. */
const WORKSPACE_MANIFEST_FILE = "workspace.toml";
/** Submodule path of the SDK checkout inside this repository. */
const SDK_SUBMODULE_PATH = "sdk";

const USAGE = `usage: bun scripts/validate-registry.ts [--skip-network]

Validates registry/official/*.toml and registry/community/*.toml.
  --skip-network   skip repository existence and pin reachability checks (also REGISTRY_SKIP_NETWORK=1)
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

/**
 * Bounded repository existence checks. The tiering itself lives in the shared
 * helper: `404`/`410` stay hard errors, other HTTP responses warn, and a
 * network error skips only the still-unchecked entries. The skipped count is
 * always reported so an offline run cannot silently void the existence gate.
 */
async function checkRepositoriesOnline(
  entries: LoadedEntry[],
): Promise<Diagnostic[]> {
  const outcome = await checkRepositoryExistence(entries, {
    check: (url) => fetchWithTimeout(url),
  });
  if (outcome.offline) {
    console.log(
      `notice: repository existence checks: ${outcome.checked} checked, ${outcome.skipped} skipped after a network error (unverified)`,
    );
    return [
      ...outcome.diagnostics,
      {
        severity: "warning",
        file: "registry/",
        message: `repository existence checks skipped for ${outcome.skipped} entr(ies) after a network error; they remain unverified`,
      },
    ];
  }
  return outcome.diagnostics;
}

interface ParsedManifest {
  plugin?: { id?: unknown; name?: unknown; license?: unknown };
}

/**
 * Nearest ancestor directory of the checkout that carries the flat-workspace
 * marker, or null when the checkout is standalone. Walking up (rather than
 * assuming the parent) keeps sibling resolution working from a linked Git
 * worktree like `.worktrees/<task>`, and never invents a host path.
 */
function resolveWorkspaceRoot(): string | null {
  let current = resolve(REPO_ROOT, "..");
  while (true) {
    if (existsSync(join(current, WORKSPACE_MANIFEST_FILE))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the SDK checkout: the `BITTY_PLUGIN_SDK_DIR` override first, then the
 * in-repo `sdk/` submodule, then the workspace-relative sibling named after the
 * SDK submodule URL. The sibling name is derived from `.gitmodules`, so no
 * repository name or host path is hardcoded here.
 */
function resolveSdkLocation(): SdkDirResolution | null {
  const { submodules } = loadSubmoduleState();
  const sdkSubmodule = submodules.find(
    (submodule) => submodule.path === SDK_SUBMODULE_PATH,
  );
  const workspace = resolveWorkspaceRoot();
  const siblingDirs: string[] = [];
  if (workspace !== null && sdkSubmodule !== undefined) {
    const sibling = repositoryName(sdkSubmodule.url);
    if (sibling.length > 0) siblingDirs.push(join(workspace, sibling));
  }
  return resolveSdkDir(
    {
      envDir: process.env[SDK_ENV_VAR],
      submoduleDir: join(REPO_ROOT, SDK_SUBMODULE_PATH),
      siblingDirs,
    },
    (dir) => existsSync(join(dir, "package.json")),
  );
}

/** A manifest path label that never embeds an absolute host path. */
function manifestLabel(name: string, path: string): string {
  const submodulePath = join(REPO_ROOT, "plugins", name, PLUGIN_MANIFEST_FILE);
  return path === submodulePath
    ? path.slice(REPO_ROOT.length + 1)
    : `${name}/${PLUGIN_MANIFEST_FILE} (workspace sibling)`;
}

/**
 * Compare local official-plugin manifests with their registry entries.
 *
 * A manifest is resolved from the `plugins/<name>` submodule checkout or a
 * workspace-relative sibling repository. When neither exists the entry is not
 * silently skipped: an aggregate warning with the count is emitted so the
 * coverage gap is visible in CI instead of passing as an unchecked green.
 */
function checkLocalManifests(entries: LoadedEntry[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sdk = resolveSdkLocation();
  const sdkCli = sdk === null ? null : discoverSdkCli(sdk.dir);
  const sdkReady =
    sdk !== null && sdkCli !== null && ensureSdkDependencies(sdk.dir);
  if (sdk !== null && sdkCli !== null && sdkReady) {
    console.log(
      `notice: using SDK manifest tooling from the ${sdk.source} checkout`,
    );
  } else if (sdk !== null) {
    console.log(
      "notice: SDK manifest tooling is unavailable (no bin entry or dependencies unavailable); skipping SDK lint",
    );
  } else {
    console.log(
      `notice: SDK manifest tooling not found (set ${SDK_ENV_VAR}, initialize the ${SDK_SUBMODULE_PATH}/ submodule, or add the sibling SDK repository); skipping SDK lint`,
    );
  }

  const workspace = resolveWorkspaceRoot();
  const unresolved: string[] = [];
  for (const { entry, file, official } of entries) {
    if (!official) continue;
    const name = repositoryName(entry.repository);
    if (name.length === 0) continue;
    const manifestPath = resolveOfficialManifest(
      {
        submoduleManifest: join(
          REPO_ROOT,
          "plugins",
          name,
          PLUGIN_MANIFEST_FILE,
        ),
        siblingManifests:
          workspace === null
            ? []
            : [join(workspace, name, PLUGIN_MANIFEST_FILE)],
      },
      existsSync,
    );
    if (manifestPath === null) {
      unresolved.push(name);
      continue;
    }
    const label = manifestLabel(name, manifestPath);

    let manifest: ParsedManifest;
    try {
      manifest = Bun.TOML.parse(
        readFileSync(manifestPath, "utf8"),
      ) as ParsedManifest;
    } catch (error) {
      diagnostics.push({
        severity: "error",
        file,
        message: `cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const manifestId = manifest.plugin?.id;
    if (typeof manifestId === "string" && manifestId !== entry.id) {
      diagnostics.push({
        severity: "error",
        file,
        message: `registry id "${entry.id}" does not match manifest plugin.id "${manifestId}" in ${label}`,
      });
    }
    const manifestName = manifest.plugin?.name;
    if (typeof manifestName === "string" && manifestName !== entry.name) {
      diagnostics.push({
        severity: "warning",
        file,
        message: `registry name "${entry.name}" differs from manifest plugin.name "${manifestName}" (${label})`,
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
        message: `registry license "${entry.license}" differs from manifest plugin.license "${manifestLicense}" (${label})`,
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
          message: `SDK manifest lint failed for ${label}${stderr.length > 0 ? `: ${stderr}` : ""}`,
        });
      }
    }
  }
  if (unresolved.length > 0) {
    const warning = unresolvedOfficialManifestWarning(unresolved);
    if (warning !== null) diagnostics.push(warning);
  }
  return diagnostics;
}

/**
 * Ensure the SDK tooling's dependencies are installed before invoking it.
 * Installs with the SDK lockfile when `node_modules` is missing; offline
 * installs fail soft so the SDK lint is skipped with a notice.
 */
function ensureSdkDependencies(sdkDir: string): boolean {
  if (!existsSync(join(sdkDir, "package.json"))) return false;
  if (existsSync(join(sdkDir, "node_modules"))) return true;
  console.log(
    "notice: installing SDK tooling dependencies (node_modules missing)",
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

/** Discover the SDK CLI entry point from the SDK's `package.json` `bin`. */
function discoverSdkCli(sdkDir: string): string | null {
  const packagePath = join(sdkDir, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
      bin?: unknown;
    };
    if (typeof pkg.bin === "string") return join(sdkDir, pkg.bin);
    if (pkg.bin !== null && typeof pkg.bin === "object") {
      for (const value of Object.values(pkg.bin as Record<string, unknown>)) {
        if (typeof value === "string") return join(sdkDir, value);
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

/**
 * Load the static submodule state both offline phases share: parsed
 * `.gitmodules` entries and observed `plugins/` directory names. Missing or
 * unreadable inputs degrade to empty lists so each phase reports its own
 * precise diagnostics instead of crashing.
 */
function loadSubmoduleState(): {
  submodules: SubmoduleEntry[];
  pluginDirs: string[];
} {
  let gitmodules = "";
  try {
    gitmodules = readFileSync(join(REPO_ROOT, ".gitmodules"), "utf8");
  } catch {
    gitmodules = "";
  }
  let pluginDirs: string[] = [];
  try {
    const pluginsDir = join(REPO_ROOT, "plugins");
    if (existsSync(pluginsDir)) {
      pluginDirs = readdirSync(pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    }
  } catch {
    pluginDirs = [];
  }
  return { submodules: parseGitmodules(gitmodules), pluginDirs };
}

/**
 * Static offline check: every official entry maps to a plugins/ submodule
 * whose URL matches the entry repository, and stray plugins/ directories are
 * reported. Reads only `.gitmodules` and the `plugins/` directory listing,
 * so it runs identically online and offline, including with `--skip-network`.
 */
function checkSubmoduleMapping(entries: LoadedEntry[]): Diagnostic[] {
  const { submodules, pluginDirs } = loadSubmoduleState();
  return checkSubmoduleConsistency(
    entries,
    submodules,
    pluginDirs,
    NON_SHIPPING_PIN_EXEMPTIONS,
  );
}

/**
 * Resolve a repository's default-branch tip SHA with `git ls-remote <url>
 * HEAD`. Returns null when the tip cannot be determined (offline, unknown
 * ref, or git failure); the caller treats that as an offline halt.
 */
async function resolveDefaultTipWithGit(
  repository: string,
): Promise<string | null> {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-remote", repository, "HEAD"],
    stdout: "pipe",
    stderr: "pipe",
    timeout: PIN_LS_REMOTE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().match(/([0-9a-f]{40})\s+HEAD/)?.[1] ?? null;
}

/**
 * Compare a submodule pin against the default-branch tip via the credential-
 * free GitHub compare API. Non-OK responses surface as `httpStatus`; network
 * failures throw so the caller can halt with an offline notice.
 */
async function comparePinToTipWithApi(
  slug: GitHubSlug,
  base: string,
  head: string,
): Promise<{ status?: CompareStatus; httpStatus?: number }> {
  const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/compare/${base}...${head}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PIN_COMPARE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "bitty-plugins-registry-validate",
        Accept: "application/vnd.github+json",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return { httpStatus: response.status };
    const body = (await response.json()) as { status?: unknown };
    if (
      body.status === "ahead" ||
      body.status === "behind" ||
      body.status === "identical" ||
      body.status === "diverged"
    ) {
      return { status: body.status };
    }
    return { httpStatus: response.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the manifest at a pin from an initialized submodule checkout. Returns
 * null when the submodule is absent, the pinned object is not available
 * locally, or a spawn fails; the caller falls back to the raw URL.
 */
function readLocalManifestAtPin(name: string, pin: string): LocalManifestRead {
  try {
    const checkout = join(REPO_ROOT, "plugins", name);
    if (!existsSync(join(checkout, ".git"))) return null;
    return readManifestFromCheckout(checkout, pin);
  } catch {
    return null;
  }
}

/**
 * Fetch the pinned raw manifest with the same 256 KiB bound as the local
 * object read. Non-OK responses surface as `httpStatus`; an oversized body
 * surfaces as `oversized`; other network failures throw so the caller can
 * halt.
 */
async function fetchRawManifest(url: string): Promise<ManifestReadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PIN_MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "bitty-plugins-registry-validate",
        Accept: "text/plain",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return { httpStatus: response.status };
    try {
      return { bytes: await readBoundedBytes(response) };
    } catch (error) {
      if (isOversizedManifestError(error)) {
        return { oversized: error.bytes ?? MANIFEST_MAX_BYTES + 1 };
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the manifest at a pin, preferring the local git object and falling
 * back to the pinned raw URL. Local failures stay local; only the fallback
 * fetch can report a network failure to the caller.
 */
async function readManifestAtPin(
  request: ManifestHashRequest,
): Promise<ManifestReadResult> {
  return readPinnedManifest(request, {
    readLocal: readLocalManifestAtPin,
    fetchRaw: fetchRawManifest,
  });
}

/**
 * Bounded pin phase: prove every official `plugins/<name>` pin is an ancestor
 * of the plugin default branch and that the pinned manifest bytes match the
 * registry `manifest_hash`. A missing pin for a shipping plugin is a hard
 * error; explicit non-shipping exemptions are reported with their reason.
 * Planning and missing-pin detection always run; `checkNetwork` only gates
 * the reachability and manifest fetches. Degrades gracefully offline with a
 * notice, consistent with the repository existence guard.
 */
async function checkSubmodulePinsReachable(
  entries: LoadedEntry[],
  checkNetwork: boolean,
): Promise<Diagnostic[]> {
  const { submodules } = loadSubmoduleState();
  const pinShas = readSubmodulePins();
  if (pinShas === null) {
    return [
      {
        severity: "error",
        file: "plugins/",
        message:
          "cannot read recorded submodule pins (git ls-tree HEAD plugins/ failed); pin reachability and manifest binding cannot be verified",
      },
    ];
  }
  const plan = planPinChecks(
    entries,
    submodules,
    pinShas,
    NON_SHIPPING_PIN_EXEMPTIONS,
  );
  for (const notice of plan.notices) console.log(notice);
  const diagnostics: Diagnostic[] = [...plan.diagnostics];
  if (plan.requests.length === 0) return diagnostics;
  if (!checkNetwork) {
    console.log(
      `notice: pin reachability and manifest hash checks skipped for ${plan.requests.length} pin(s) (--skip-network)`,
    );
    return diagnostics;
  }
  const outcome = await checkPinReachability(
    plan.requests,
    {
      resolveDefaultTip: resolveDefaultTipWithGit,
      comparePinToTip: comparePinToTipWithApi,
    },
    PIN_CHECK_BUDGET_MS,
  );
  for (const notice of outcome.notices) console.log(notice);
  diagnostics.push(...outcome.diagnostics);
  if (outcome.halted) {
    console.log(
      "notice: manifest hash checks skipped after the pin reachability halt",
    );
    return diagnostics;
  }
  const manifestOutcome = await checkManifestHashes(plan.manifestRequests, {
    readManifest: readManifestAtPin,
  });
  for (const notice of manifestOutcome.notices) console.log(notice);
  diagnostics.push(...manifestOutcome.diagnostics);
  if (!manifestOutcome.halted) {
    console.log(
      `notice: pin checks: ${plan.requests.length} reachability, ${plan.manifestRequests.length} manifest hash binding(s)`,
    );
  }
  return diagnostics;
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
  diagnostics.push(...checkSubmoduleMapping(entries));
  if (skipNetwork) {
    console.log(
      `notice: repository existence checks skipped for ${countNetworkRepositories(entries)} entr(ies) (--skip-network)`,
    );
    diagnostics.push(...(await checkSubmodulePinsReachable(entries, false)));
  } else {
    diagnostics.push(...(await checkRepositoriesOnline(entries)));
    diagnostics.push(...(await checkSubmodulePinsReachable(entries, true)));
  }
  const errors = countSeverity(diagnostics, "error");
  const warnings = countSeverity(diagnostics, "warning");
  printDiagnostics(diagnostics, errors, warnings);
  return errors === 0 ? 0 : 1;
}

process.exit(await main());
