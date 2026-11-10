/**
 * Signed, versioned extension catalog snapshots (`bitty-plugins#121`).
 *
 * Owns the refreshed extension catalog contract after `bitty` PR #2826 capped
 * Core's install seed to a single pinned `(name, version, target)` artifact:
 *
 * - Versioned, Ed25519-signed snapshot (`schema_version = 1`) with a monotonic
 *   `snapshot_version`, bounded `issued_at`/`expires_at` freshness window, and
 *   `payload_sha256` digest over the exact canonical unsigned payload bytes.
 * - Key directory (`CatalogKeyDirectory`) with `active`, `retired`, and
 *   `revoked` lifecycle states and `[not_before, not_after]` validity windows
 *   for seamless key rotation and immediate revocation.
 * - Strict closed-schema validation: unknown fields at any level (key
 *   directory, snapshot root, entry, or signature) fail closed with
 *   `E_CATALOG_UNKNOWN_FIELD`.
 * - Shared size and count bounds (`CATALOG_MAX_BYTES`, `CATALOG_MAX_ENTRIES`,
 *   `CATALOG_MAX_ENTRY_BYTES`, `CATALOG_MAX_TTL_MS`) enforced by both the
 *   publisher and the reader so the publisher can never emit a snapshot that
 *   the reader rejects.
 * - Anti-rollback (`minSnapshotVersion` + same-version digest pinning) and
 *   release `SHA256SUMS` cross-check before any version is offered.
 * - Seed preservation: the offline bootstrap seed (`name + exact version +
 *   target + pinned sha256`) remains the only offline bootstrap path; clients
 *   never fall back to unverified "latest tag" guessing.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_SEMVER_COMPONENT = 4294967295;

export interface StrictSemver {
  major: number;
  minor: number;
  patch: number;
}

export function parseStrictSemver(version: string): StrictSemver | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
    version,
  );
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    major > MAX_SEMVER_COMPONENT ||
    minor > MAX_SEMVER_COMPONENT ||
    patch > MAX_SEMVER_COMPONENT
  ) {
    return null;
  }
  return { major, minor, patch };
}

export function compareStrictSemver(a: StrictSemver, b: StrictSemver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export const CATALOG_SNAPSHOT_SCHEMA_VERSION = 1;
export const CATALOG_KEY_DIRECTORY_SCHEMA_VERSION = 1;
export const CATALOG_SIGNATURE_ALGORITHM = "ed25519" as const;
export const CATALOG_SIGNING_DOMAIN = "bitty-extension-catalog-v1";

/** Hard cap on a serialized snapshot JSON document (256 KiB). */
export const CATALOG_MAX_BYTES = 256 * 1024;
/** Hard cap on the number of `(name, version, target)` entries in one snapshot. */
export const CATALOG_MAX_ENTRIES = 1024;
/** Hard cap on the serialized UTF-8 byte length of a single catalog entry. */
export const CATALOG_MAX_ENTRY_BYTES = 512;
/** Hard cap on the number of keys in a key directory. */
export const CATALOG_MAX_KEYS = 16;
/** Maximum allowed freshness window (`expires_at - issued_at`): 7 days. */
export const CATALOG_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum tolerated future clock skew on `issued_at`: 5 minutes. */
export const CATALOG_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Hard cap on a release `SHA256SUMS` file (64 KiB, matching Core seed bounds). */
export const SHA256SUMS_MAX_BYTES = 64 * 1024;
export const SHA256SUMS_MAX_LINES = 4096;
export const SHA256SUMS_MAX_LINE_BYTES = 1024;

export const EXTENSION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const EXTENSION_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const EXTENSION_TARGET_PATTERN = /^[a-z0-9_]+(?:-[a-z0-9_]+)+$/;
export const EXTENSION_TARGET_MAX_BYTES = 64;
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const PREFIXED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const HEX_ED25519_PUBKEY_PATTERN = /^[0-9a-f]{64}$/;
export const HEX_ED25519_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;
export const UTC_ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** ASN.1 DER SPKI prefix for a raw 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** ASN.1 DER PKCS#8 prefix for a raw 32-byte Ed25519 private seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export type CatalogDiagnosticCode =
  | "E_CATALOG_OVERSIZED"
  | "E_CATALOG_MALFORMED_JSON"
  | "E_CATALOG_UNKNOWN_FIELD"
  | "E_CATALOG_INVALID_SCHEMA"
  | "E_CATALOG_UNSIGNED"
  | "E_CATALOG_DIGEST_MISMATCH"
  | "E_CATALOG_SIGNATURE_INVALID"
  | "E_CATALOG_STALE"
  | "E_CATALOG_DOWNGRADE"
  | "E_CATALOG_ARTIFACT_MISMATCH"
  | "E_CATALOG_NOT_FOUND";

export class CatalogError extends Error {
  readonly code: CatalogDiagnosticCode;

  constructor(code: CatalogDiagnosticCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CatalogError";
    this.code = code;
  }
}

export type CatalogKeyStatus = "active" | "retired" | "revoked";

export interface CatalogSigningKey {
  key_id: string;
  algorithm: typeof CATALOG_SIGNATURE_ALGORITHM;
  /** 64 lowercase hex characters (raw 32-byte Ed25519 public key). */
  public_key: string;
  status: CatalogKeyStatus;
  /** UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SSZ`). */
  not_before: string;
  /** Optional UTC ISO-8601 expiry timestamp (`YYYY-MM-DDTHH:MM:SSZ`). */
  not_after?: string;
}

export interface CatalogKeyDirectory {
  schema_version: typeof CATALOG_KEY_DIRECTORY_SCHEMA_VERSION;
  keys: CatalogSigningKey[];
}

export interface ExtensionCatalogEntry {
  name: string;
  version: string;
  target: string;
  /** Lowercase 64-char hex SHA-256 of `<target>.tar.gz`. */
  sha256: string;
  /** Lowercase 64-char hex SHA-256 of the release `SHA256SUMS` manifest. */
  sha256sums_sha256: string;
}

export interface ExtensionCatalogUnsignedPayload {
  schema_version: typeof CATALOG_SNAPSHOT_SCHEMA_VERSION;
  snapshot_version: number;
  issued_at: string;
  expires_at: string;
  entries: ExtensionCatalogEntry[];
}

export interface ExtensionCatalogSignature {
  algorithm: typeof CATALOG_SIGNATURE_ALGORITHM;
  key_id: string;
  /** Lowercase 128-char hex Ed25519 signature. */
  value: string;
}

export interface ExtensionCatalogSnapshot extends ExtensionCatalogUnsignedPayload {
  /** `sha256:<64-hex>` over `canonicalUnsignedPayloadBytes(snapshot)`. */
  payload_sha256: string;
  signature: ExtensionCatalogSignature;
}

export interface ReleaseManifestRecord {
  name: string;
  version: string;
  /** Raw UTF-8 text of `<name>/<version>/SHA256SUMS`. */
  sha256sumsText: string;
  /** Optional map of `<target> -> actual tarball sha256` for artifact verification. */
  artifactDigests?: Readonly<Record<string, string>>;
}

export interface BuildCatalogSnapshotInput {
  snapshotVersion: number;
  issuedAt: string;
  expiresAt: string;
  entries: ExtensionCatalogEntry[];
  keyId: string;
  /** 64-char hex seed (32 bytes) or PEM/KeyObject private key. */
  privateKey: string | KeyObject;
  keyDirectory?: CatalogKeyDirectory;
  allowEmpty?: boolean;
}

export interface VerifyCatalogSnapshotOptions {
  keyDirectory: CatalogKeyDirectory;
  /** Current wall-clock time in milliseconds since Unix epoch. */
  nowMs: number;
  /** Highest previously accepted `snapshot_version` (anti-downgrade floor). */
  minSnapshotVersion?: number;
  /**
   * Optional `payload_sha256` of `minSnapshotVersion` so a replay of the same
   * version with different bytes fails closed.
   */
  acceptedSnapshotDigest?: string;
  /**
   * Optional release `SHA256SUMS` manifests to cross-check every catalog entry
   * against before accepting the snapshot.
   */
  releaseManifests?: readonly ReleaseManifestRecord[];
  allowEmpty?: boolean;
}

export interface SeedBootstrapEntry {
  name: string;
  version: string;
  target: string;
  sha256: string;
}

export interface ResolveCatalogRequest {
  name: string;
  target: string;
  /** Exact `X.Y.Z` version; when omitted, selects the highest verified semver in the snapshot. */
  version?: string;
  /**Verified snapshot (normal resolution path). */
  snapshot?: ExtensionCatalogSnapshot;
  verifyOptions?: VerifyCatalogSnapshotOptions;
  /**
   * Explicit offline bootstrap seed fallback. Used only when `snapshot` is
   * absent and `allowSeedBootstrap` is true; requires an exact `version` match.
   */
  seedBootstrap?: SeedBootstrapEntry;
  allowSeedBootstrap?: boolean;
}

export interface ResolvedExtensionArtifact {
  name: string;
  version: string;
  target: string;
  sha256: string;
  source: "catalog-snapshot" | "seed-bootstrap";
  snapshot_version?: number;
}

const SNAPSHOT_ROOT_KEYS = new Set([
  "schema_version",
  "snapshot_version",
  "issued_at",
  "expires_at",
  "entries",
  "payload_sha256",
  "signature",
]);

const ENTRY_KEYS = new Set([
  "name",
  "version",
  "target",
  "sha256",
  "sha256sums_sha256",
]);

const SIGNATURE_KEYS = new Set(["algorithm", "key_id", "value"]);

const KEY_DIRECTORY_KEYS = new Set(["schema_version", "keys"]);

const SIGNING_KEY_KEYS = new Set([
  "key_id",
  "algorithm",
  "public_key",
  "status",
  "not_before",
  "not_after",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertClosedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new CatalogError(
        "E_CATALOG_UNKNOWN_FIELD",
        `unknown field \`${key}\` in ${context}`,
      );
    }
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function parseUtcIsoTimestamp(
  value: unknown,
  fieldName: string,
): number {
  if (typeof value !== "string" || !UTC_ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `\`${fieldName}\` must be a UTC ISO-8601 timestamp (YYYY-MM-DDTHH:MM:SSZ)`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `\`${fieldName}\` is not a valid calendar timestamp`,
    );
  }
  // Reject rollover dates like 2026-02-30T00:00:00Z by round-tripping.
  const canonical = new Date(ms).toISOString().replace(".000Z", "Z");
  if (canonical !== value) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `\`${fieldName}\` is not a valid calendar date (${value})`,
    );
  }
  return ms;
}

export function compareCatalogEntries(
  a: ExtensionCatalogEntry,
  b: ExtensionCatalogEntry,
): number {
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  const va = parseStrictSemver(a.version);
  const vb = parseStrictSemver(b.version);
  if (va !== null && vb !== null) {
    const cmp = compareStrictSemver(va, vb);
    if (cmp !== 0) return cmp;
  } else if (a.version !== b.version) {
    return a.version < b.version ? -1 : 1;
  }
  if (a.target !== b.target) {
    return a.target < b.target ? -1 : 1;
  }
  return 0;
}

export function validateCatalogEntry(
  raw: unknown,
  index: number,
): ExtensionCatalogEntry {
  const ctx = `entries[${index}]`;
  if (!isPlainObject(raw)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `${ctx} must be an object`,
    );
  }
  assertClosedKeys(raw, ENTRY_KEYS, ctx);

  const { name, version, target, sha256, sha256sums_sha256 } = raw;
  if (typeof name !== "string" || !EXTENSION_NAME_PATTERN.test(name)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `${ctx}.name must match ${EXTENSION_NAME_PATTERN}`,
    );
  }
  if (
    typeof version !== "string" ||
    !EXTENSION_VERSION_PATTERN.test(version) ||
    parseStrictSemver(version) === null
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `${ctx}.version must be strict numeric X.Y.Z`,
    );
  }
  if (
    typeof target !== "string" ||
    Buffer.byteLength(target, "utf8") > EXTENSION_TARGET_MAX_BYTES ||
    !EXTENSION_TARGET_PATTERN.test(target)
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `${ctx}.target must be a valid target triple (<= ${EXTENSION_TARGET_MAX_BYTES} bytes)`,
    );
  }
  if (typeof sha256 !== "string" || !HEX_SHA256_PATTERN.test(sha256)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `${ctx}.sha256 must be 64 lowercase hex characters`,
    );
  }
  if (
    typeof sha256sums_sha256 !== "string" ||
    !HEX_SHA256_PATTERN.test(sha256sums_sha256)
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `${ctx}.sha256sums_sha256 must be 64 lowercase hex characters`,
    );
  }

  const normalized: ExtensionCatalogEntry = {
    name,
    version,
    target,
    sha256,
    sha256sums_sha256,
  };
  const entryBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (entryBytes > CATALOG_MAX_ENTRY_BYTES) {
    throw new CatalogError(
      "E_CATALOG_OVERSIZED",
      `${ctx} serialized size (${entryBytes} bytes) exceeds ${CATALOG_MAX_ENTRY_BYTES}-byte limit`,
    );
  }
  return normalized;
}

export function validateKeyDirectory(raw: unknown): CatalogKeyDirectory {
  if (!isPlainObject(raw)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "key directory must be an object",
    );
  }
  assertClosedKeys(raw, KEY_DIRECTORY_KEYS, "key_directory");

  if (raw.schema_version !== CATALOG_KEY_DIRECTORY_SCHEMA_VERSION) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `key_directory.schema_version must be ${CATALOG_KEY_DIRECTORY_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(raw.keys)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "key_directory.keys must be an array",
    );
  }
  if (raw.keys.length === 0 || raw.keys.length > CATALOG_MAX_KEYS) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `key_directory.keys must contain 1..${CATALOG_MAX_KEYS} keys`,
    );
  }

  const seenIds = new Set<string>();
  const keys: CatalogSigningKey[] = [];
  for (let i = 0; i < raw.keys.length; i++) {
    const item = raw.keys[i];
    const ctx = `key_directory.keys[${i}]`;
    if (!isPlainObject(item)) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `${ctx} must be an object`,
      );
    }
    assertClosedKeys(item, SIGNING_KEY_KEYS, ctx);

    const { key_id, algorithm, public_key, status, not_before, not_after } =
      item;
    if (typeof key_id !== "string" || !KEY_ID_PATTERN.test(key_id)) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `${ctx}.key_id must match ${KEY_ID_PATTERN}`,
      );
    }
    if (seenIds.has(key_id)) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `duplicate key_id \`${key_id}\` in key_directory`,
      );
    }
    seenIds.add(key_id);

    if (algorithm !== CATALOG_SIGNATURE_ALGORITHM) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `${ctx}.algorithm must be "${CATALOG_SIGNATURE_ALGORITHM}"`,
      );
    }
    if (
      typeof public_key !== "string" ||
      !HEX_ED25519_PUBKEY_PATTERN.test(public_key)
    ) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `${ctx}.public_key must be 64 lowercase hex characters`,
      );
    }
    if (status !== "active" && status !== "retired" && status !== "revoked") {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `${ctx}.status must be "active", "retired", or "revoked"`,
      );
    }
    const notBeforeMs = parseUtcIsoTimestamp(not_before, `${ctx}.not_before`);
    let normalizedNotAfter: string | undefined;
    if (not_after !== undefined) {
      const notAfterMs = parseUtcIsoTimestamp(not_after, `${ctx}.not_after`);
      if (notAfterMs <= notBeforeMs) {
        throw new CatalogError(
          "E_CATALOG_INVALID_SCHEMA",
          `${ctx}.not_after must be strictly after not_before`,
        );
      }
      normalizedNotAfter = not_after as string;
    }

    const keyEntry: CatalogSigningKey = {
      key_id,
      algorithm: CATALOG_SIGNATURE_ALGORITHM,
      public_key,
      status,
      not_before: not_before as string,
    };
    if (normalizedNotAfter !== undefined) {
      keyEntry.not_after = normalizedNotAfter;
    }
    keys.push(keyEntry);
  }

  return {
    schema_version: CATALOG_KEY_DIRECTORY_SCHEMA_VERSION,
    keys,
  };
}

/**
 * Deterministic JSON serialization of the unsigned snapshot payload.
 * Key order is fixed (`schema_version`, `snapshot_version`, `issued_at`,
 * `expires_at`, `entries`) and each entry's key order is fixed (`name`,
 * `version`, `target`, `sha256`, `sha256sums_sha256`).
 */
export function canonicalUnsignedPayloadJson(
  payload: ExtensionCatalogUnsignedPayload,
): string {
  const canonicalEntries = payload.entries.map((e) => ({
    name: e.name,
    version: e.version,
    target: e.target,
    sha256: e.sha256,
    sha256sums_sha256: e.sha256sums_sha256,
  }));
  return JSON.stringify({
    schema_version: payload.schema_version,
    snapshot_version: payload.snapshot_version,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    entries: canonicalEntries,
  });
}

export function computePayloadDigest(
  payload: ExtensionCatalogUnsignedPayload,
): string {
  const json = canonicalUnsignedPayloadJson(payload);
  return `sha256:${sha256Hex(json)}`;
}

export function signingPreimageBytes(
  payloadDigest: string,
  payload: ExtensionCatalogUnsignedPayload,
): Buffer {
  const json = canonicalUnsignedPayloadJson(payload);
  return Buffer.from(
    `${CATALOG_SIGNING_DOMAIN}\n${payloadDigest}\n${json}`,
    "utf8",
  );
}

export function ed25519PublicKeyFromHex(publicKeyHex: string): KeyObject {
  if (!HEX_ED25519_PUBKEY_PATTERN.test(publicKeyHex)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "Ed25519 public key must be 64 lowercase hex characters",
    );
  }
  const der = Buffer.concat([
    ED25519_SPKI_PREFIX,
    Buffer.from(publicKeyHex, "hex"),
  ]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export function ed25519PrivateKeyFromSeedHex(seedHex: string): KeyObject {
  if (!HEX_SHA256_PATTERN.test(seedHex)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "Ed25519 private seed must be 64 lowercase hex characters",
    );
  }
  const der = Buffer.concat([
    ED25519_PKCS8_PREFIX,
    Buffer.from(seedHex, "hex"),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function generateEd25519KeyMaterial(): {
  privateSeedHex: string;
  publicKeyHex: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const publicKeyHex = spki
    .subarray(ED25519_SPKI_PREFIX.length)
    .toString("hex");
  const privateSeedHex = pkcs8
    .subarray(ED25519_PKCS8_PREFIX.length)
    .toString("hex");
  return { privateSeedHex, publicKeyHex, privateKey, publicKey };
}

/**
 * Parse and validate a release `SHA256SUMS` manifest (matching Core's
 * `extension-install-seed.md` bounds: <= 64 KiB, <= 4096 lines, <= 1024 bytes
 * per line, `<64-hex>  <target>.tar.gz`).
 */
export function parseReleaseSha256Sums(
  name: string,
  version: string,
  sha256sumsText: string,
  artifactDigests?: Readonly<Record<string, string>>,
): ExtensionCatalogEntry[] {
  if (!EXTENSION_NAME_PATTERN.test(name)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `invalid extension name \`${name}\``,
    );
  }
  if (
    !EXTENSION_VERSION_PATTERN.test(version) ||
    parseStrictSemver(version) === null
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `invalid extension version \`${version}\``,
    );
  }
  const byteLength = Buffer.byteLength(sha256sumsText, "utf8");
  if (byteLength === 0 || byteLength > SHA256SUMS_MAX_BYTES) {
    throw new CatalogError(
      "E_CATALOG_OVERSIZED",
      `SHA256SUMS for ${name}@${version} must be 1..${SHA256SUMS_MAX_BYTES} bytes (got ${byteLength})`,
    );
  }

  const lines = sha256sumsText.split("\n");
  if (lines.length > SHA256SUMS_MAX_LINES) {
    throw new CatalogError(
      "E_CATALOG_OVERSIZED",
      `SHA256SUMS for ${name}@${version} exceeds ${SHA256SUMS_MAX_LINES} lines`,
    );
  }

  const manifestDigest = sha256Hex(sha256sumsText);
  const seenTargets = new Set<string>();
  const entries: ExtensionCatalogEntry[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (Buffer.byteLength(line, "utf8") > SHA256SUMS_MAX_LINE_BYTES) {
      throw new CatalogError(
        "E_CATALOG_OVERSIZED",
        `SHA256SUMS line for ${name}@${version} exceeds ${SHA256SUMS_MAX_LINE_BYTES} bytes`,
      );
    }
    if (line.trim().length === 0) continue;

    const match = /^([0-9a-fA-F]{64})[ \t]{1,2}\*?([^ \t]+)$/.exec(line);
    const rawDigest = match?.[1];
    const file = match?.[2];
    if (rawDigest === undefined || file === undefined) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `malformed SHA256SUMS line for ${name}@${version}: ${line}`,
      );
    }
    const digest = rawDigest.toLowerCase();
    if (!file.endsWith(".tar.gz")) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `SHA256SUMS entry is not a .tar.gz archive for ${name}@${version}: ${file}`,
      );
    }
    const target = file.slice(0, -".tar.gz".length);
    if (
      Buffer.byteLength(target, "utf8") > EXTENSION_TARGET_MAX_BYTES ||
      !EXTENSION_TARGET_PATTERN.test(target)
    ) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `invalid target triple in SHA256SUMS for ${name}@${version}: ${target}`,
      );
    }
    if (seenTargets.has(target)) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `duplicate target \`${target}\` in SHA256SUMS for ${name}@${version}`,
      );
    }
    seenTargets.add(target);

    if (artifactDigests !== undefined) {
      const actual = artifactDigests[target]?.toLowerCase();
      if (actual === undefined) {
        throw new CatalogError(
          "E_CATALOG_ARTIFACT_MISMATCH",
          `missing artifact digest for ${name}@${version} (${target})`,
        );
      }
      if (actual !== digest) {
        throw new CatalogError(
          "E_CATALOG_ARTIFACT_MISMATCH",
          `artifact digest mismatch for ${name}@${version} (${target}): SHA256SUMS has ${digest}, artifact is ${actual}`,
        );
      }
    }

    entries.push(
      validateCatalogEntry(
        {
          name,
          version,
          target,
          sha256: digest,
          sha256sums_sha256: manifestDigest,
        },
        entries.length,
      ),
    );
  }

  if (entries.length === 0) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `SHA256SUMS for ${name}@${version} contains no entries`,
    );
  }

  return entries.sort(compareCatalogEntries);
}

/**
 * Discover local `<sourceDir>/<name>/<version>/SHA256SUMS` releases and verify
 * every referenced `<target>.tar.gz` payload digest on disk.
 */
export function discoverLocalExtensionReleases(sourceDir: string): {
  entries: ExtensionCatalogEntry[];
  manifests: ReleaseManifestRecord[];
} {
  const root = resolve(sourceDir);
  if (!existsSync(root)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `source directory does not exist: ${root}`,
    );
  }
  const manifests: ReleaseManifestRecord[] = [];
  const entries: ExtensionCatalogEntry[] = [];

  const names = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const name of names) {
    const nameDir = join(root, name);
    const versions = readdirSync(nameDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const version of versions) {
      const versionDir = join(nameDir, version);
      const manifestPath = join(versionDir, "SHA256SUMS");
      if (!existsSync(manifestPath)) continue;

      const sha256sumsText = readFileSync(manifestPath, "utf8");
      const artifactDigests: Record<string, string> = {};
      for (const item of readdirSync(versionDir, { withFileTypes: true })) {
        if (!item.isFile() || !item.name.endsWith(".tar.gz")) continue;
        const target = item.name.slice(0, -".tar.gz".length);
        const bytes = readFileSync(join(versionDir, item.name));
        if (bytes.byteLength === 0) {
          throw new CatalogError(
            "E_CATALOG_ARTIFACT_MISMATCH",
            `empty artifact tarball for ${name}@${version} (${item.name})`,
          );
        }
        artifactDigests[target] = sha256Hex(bytes);
      }

      const releaseEntries = parseReleaseSha256Sums(
        name,
        version,
        sha256sumsText,
        artifactDigests,
      );
      manifests.push({
        name,
        version,
        sha256sumsText,
        artifactDigests,
      });
      entries.push(...releaseEntries);
    }
  }

  entries.sort(compareCatalogEntries);
  return { entries, manifests };
}

/**
 * Build, sign, and self-verify a versioned extension catalog snapshot.
 * Enforces the exact same size, entry, freshness, and signature bounds as the
 * reader so the publisher can never emit a snapshot that the reader rejects.
 */
export function buildExtensionCatalogSnapshot(
  input: BuildCatalogSnapshotInput,
): { snapshot: ExtensionCatalogSnapshot; json: string } {
  if (
    !Number.isSafeInteger(input.snapshotVersion) ||
    input.snapshotVersion < 1
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "`snapshot_version` must be a positive integer >= 1",
    );
  }
  if (!KEY_ID_PATTERN.test(input.keyId)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `\`key_id\` must match ${KEY_ID_PATTERN}`,
    );
  }

  const issuedMs = parseUtcIsoTimestamp(input.issuedAt, "issued_at");
  const expiresMs = parseUtcIsoTimestamp(input.expiresAt, "expires_at");
  if (expiresMs <= issuedMs) {
    throw new CatalogError(
      "E_CATALOG_STALE",
      "`expires_at` must be strictly after `issued_at`",
    );
  }
  if (expiresMs - issuedMs > CATALOG_MAX_TTL_MS) {
    throw new CatalogError(
      "E_CATALOG_STALE",
      `snapshot TTL (${expiresMs - issuedMs} ms) exceeds maximum ${CATALOG_MAX_TTL_MS} ms`,
    );
  }

  const allowEmpty = input.allowEmpty === true;
  if (!allowEmpty && input.entries.length === 0) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "refusing to build an empty extension catalog snapshot without allowEmpty",
    );
  }
  if (input.entries.length > CATALOG_MAX_ENTRIES) {
    throw new CatalogError(
      "E_CATALOG_OVERSIZED",
      `entry count (${input.entries.length}) exceeds ${CATALOG_MAX_ENTRIES}`,
    );
  }

  const validatedEntries = input.entries
    .map((e, i) => validateCatalogEntry(e, i))
    .sort(compareCatalogEntries);

  for (let i = 1; i < validatedEntries.length; i++) {
    const prev = validatedEntries[i - 1];
    const curr = validatedEntries[i];
    if (
      prev !== undefined &&
      curr !== undefined &&
      prev.name === curr.name &&
      prev.version === curr.version &&
      prev.target === curr.target
    ) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        `duplicate catalog entry for ${curr.name}@${curr.version} (${curr.target})`,
      );
    }
  }

  const unsignedPayload: ExtensionCatalogUnsignedPayload = {
    schema_version: CATALOG_SNAPSHOT_SCHEMA_VERSION,
    snapshot_version: input.snapshotVersion,
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    entries: validatedEntries,
  };

  const payloadSha256 = computePayloadDigest(unsignedPayload);
  const preimage = signingPreimageBytes(payloadSha256, unsignedPayload);
  const privKey =
    typeof input.privateKey === "string"
      ? ed25519PrivateKeyFromSeedHex(input.privateKey)
      : input.privateKey;
  const sigBytes = cryptoSign(null, preimage, privKey);

  const snapshot: ExtensionCatalogSnapshot = {
    ...unsignedPayload,
    payload_sha256: payloadSha256,
    signature: {
      algorithm: CATALOG_SIGNATURE_ALGORITHM,
      key_id: input.keyId,
      value: sigBytes.toString("hex"),
    },
  };

  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  const totalBytes = Buffer.byteLength(json, "utf8");
  if (totalBytes > CATALOG_MAX_BYTES) {
    throw new CatalogError(
      "E_CATALOG_OVERSIZED",
      `serialized snapshot (${totalBytes} bytes) exceeds ${CATALOG_MAX_BYTES}-byte limit`,
    );
  }

  if (input.keyDirectory !== undefined) {
    const validatedDir = validateKeyDirectory(input.keyDirectory);
    const publisherKey = validatedDir.keys.find(
      (k) => k.key_id === input.keyId,
    );
    if (publisherKey === undefined) {
      throw new CatalogError(
        "E_CATALOG_SIGNATURE_INVALID",
        `publisher key_id \`${input.keyId}\` is not present in key_directory`,
      );
    }
    if (publisherKey.status !== "active") {
      throw new CatalogError(
        "E_CATALOG_SIGNATURE_INVALID",
        `publisher key_id \`${input.keyId}\` has status "${publisherKey.status}"; only "active" keys may sign new snapshots`,
      );
    }
    verifyExtensionCatalogSnapshot(json, {
      keyDirectory: validatedDir,
      nowMs: issuedMs,
      minSnapshotVersion: input.snapshotVersion,
      acceptedSnapshotDigest: payloadSha256,
      allowEmpty,
    });
  }

  return { snapshot, json };
}

/**
 * Parse and verify a signed extension catalog snapshot (raw JSON string, UTF-8
 * bytes, or parsed object). Fails closed with a typed `CatalogError` on any
 * size, schema, unknown-field, signature, freshness, downgrade, or artifact
 * digest violation.
 */
export function verifyExtensionCatalogSnapshot(
  rawInput: string | Uint8Array | unknown,
  options: VerifyCatalogSnapshotOptions,
): ExtensionCatalogSnapshot {
  const keyDirectory = validateKeyDirectory(options.keyDirectory);
  if (!Number.isFinite(options.nowMs)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "`nowMs` must be a finite timestamp",
    );
  }

  let parsed: unknown;
  if (typeof rawInput === "string" || rawInput instanceof Uint8Array) {
    const byteLength =
      typeof rawInput === "string"
        ? Buffer.byteLength(rawInput, "utf8")
        : rawInput.byteLength;
    if (byteLength > CATALOG_MAX_BYTES) {
      throw new CatalogError(
        "E_CATALOG_OVERSIZED",
        `snapshot size (${byteLength} bytes) exceeds ${CATALOG_MAX_BYTES}-byte limit`,
      );
    }
    const text =
      typeof rawInput === "string"
        ? rawInput
        : new TextDecoder("utf-8", { fatal: true }).decode(rawInput);
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new CatalogError(
        "E_CATALOG_MALFORMED_JSON",
        `snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    const serialized = JSON.stringify(rawInput);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > CATALOG_MAX_BYTES
    ) {
      throw new CatalogError(
        "E_CATALOG_OVERSIZED",
        `snapshot exceeds ${CATALOG_MAX_BYTES}-byte limit`,
      );
    }
    parsed = rawInput;
  }

  if (!isPlainObject(parsed)) {
    throw new CatalogError(
      "E_CATALOG_MALFORMED_JSON",
      "snapshot root must be a JSON object",
    );
  }
  assertClosedKeys(parsed, SNAPSHOT_ROOT_KEYS, "snapshot");

  if (parsed.schema_version !== CATALOG_SNAPSHOT_SCHEMA_VERSION) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `snapshot.schema_version must be ${CATALOG_SNAPSHOT_SCHEMA_VERSION}`,
    );
  }

  const snapshotVersion = parsed.snapshot_version;
  if (
    !Number.isSafeInteger(snapshotVersion) ||
    (snapshotVersion as number) < 1
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "snapshot.snapshot_version must be a positive integer >= 1",
    );
  }

  const issuedMs = parseUtcIsoTimestamp(parsed.issued_at, "issued_at");
  const expiresMs = parseUtcIsoTimestamp(parsed.expires_at, "expires_at");
  if (expiresMs <= issuedMs) {
    throw new CatalogError(
      "E_CATALOG_STALE",
      "snapshot `expires_at` must be strictly after `issued_at`",
    );
  }
  if (expiresMs - issuedMs > CATALOG_MAX_TTL_MS) {
    throw new CatalogError(
      "E_CATALOG_STALE",
      `snapshot freshness window (${expiresMs - issuedMs} ms) exceeds maximum ${CATALOG_MAX_TTL_MS} ms`,
    );
  }
  if (issuedMs > options.nowMs + CATALOG_MAX_FUTURE_SKEW_MS) {
    throw new CatalogError(
      "E_CATALOG_STALE",
      `snapshot \`issued_at\` (${parsed.issued_at as string}) is in the future beyond tolerated skew`,
    );
  }
  if (options.nowMs > expiresMs) {
    throw new CatalogError(
      "E_CATALOG_STALE",
      `snapshot expired at ${parsed.expires_at as string}`,
    );
  }

  if (
    options.minSnapshotVersion !== undefined &&
    (snapshotVersion as number) < options.minSnapshotVersion
  ) {
    throw new CatalogError(
      "E_CATALOG_DOWNGRADE",
      `refusing snapshot_version ${snapshotVersion} older than accepted version ${options.minSnapshotVersion}`,
    );
  }

  if (!Array.isArray(parsed.entries)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "snapshot.entries must be an array",
    );
  }
  const allowEmpty = options.allowEmpty === true;
  if (!allowEmpty && parsed.entries.length === 0) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "snapshot.entries must not be empty",
    );
  }
  if (parsed.entries.length > CATALOG_MAX_ENTRIES) {
    throw new CatalogError(
      "E_CATALOG_OVERSIZED",
      `snapshot.entries count (${parsed.entries.length}) exceeds ${CATALOG_MAX_ENTRIES}`,
    );
  }

  const entries: ExtensionCatalogEntry[] = [];
  for (let i = 0; i < parsed.entries.length; i++) {
    const entry = validateCatalogEntry(parsed.entries[i], i);
    const prev = i > 0 ? entries[i - 1] : undefined;
    if (prev !== undefined) {
      const cmp = compareCatalogEntries(prev, entry);
      if (cmp === 0) {
        throw new CatalogError(
          "E_CATALOG_INVALID_SCHEMA",
          `duplicate catalog entry for ${entry.name}@${entry.version} (${entry.target})`,
        );
      }
      if (cmp > 0) {
        throw new CatalogError(
          "E_CATALOG_INVALID_SCHEMA",
          `snapshot.entries must be sorted in canonical (name, version, target) order at index ${i}`,
        );
      }
    }
    entries.push(entry);
  }

  const payloadSha256 = parsed.payload_sha256;
  if (
    typeof payloadSha256 !== "string" ||
    !PREFIXED_SHA256_PATTERN.test(payloadSha256)
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "snapshot.payload_sha256 must match `sha256:<64 lowercase hex>`",
    );
  }

  const unsignedPayload: ExtensionCatalogUnsignedPayload = {
    schema_version: CATALOG_SNAPSHOT_SCHEMA_VERSION,
    snapshot_version: snapshotVersion as number,
    issued_at: parsed.issued_at as string,
    expires_at: parsed.expires_at as string,
    entries,
  };
  const expectedPayloadSha256 = computePayloadDigest(unsignedPayload);
  if (payloadSha256 !== expectedPayloadSha256) {
    throw new CatalogError(
      "E_CATALOG_DIGEST_MISMATCH",
      `snapshot payload_sha256 mismatch (declared ${payloadSha256}, computed ${expectedPayloadSha256})`,
    );
  }

  if (
    options.minSnapshotVersion !== undefined &&
    (snapshotVersion as number) === options.minSnapshotVersion &&
    options.acceptedSnapshotDigest !== undefined &&
    payloadSha256 !== options.acceptedSnapshotDigest
  ) {
    throw new CatalogError(
      "E_CATALOG_DOWNGRADE",
      `snapshot_version ${snapshotVersion} replayed with different payload_sha256`,
    );
  }

  if (parsed.signature === undefined || parsed.signature === null) {
    throw new CatalogError(
      "E_CATALOG_UNSIGNED",
      "snapshot is missing required `signature` object",
    );
  }
  if (!isPlainObject(parsed.signature)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      "snapshot.signature must be an object",
    );
  }
  assertClosedKeys(parsed.signature, SIGNATURE_KEYS, "snapshot.signature");

  const { algorithm, key_id, value: sigValue } = parsed.signature;
  if (algorithm !== CATALOG_SIGNATURE_ALGORITHM) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `snapshot.signature.algorithm must be "${CATALOG_SIGNATURE_ALGORITHM}"`,
    );
  }
  if (typeof key_id !== "string" || !KEY_ID_PATTERN.test(key_id)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `snapshot.signature.key_id must match ${KEY_ID_PATTERN}`,
    );
  }
  if (typeof sigValue !== "string" || sigValue.length === 0) {
    throw new CatalogError(
      "E_CATALOG_UNSIGNED",
      "snapshot.signature.value must not be empty",
    );
  }
  if (!HEX_ED25519_SIGNATURE_PATTERN.test(sigValue)) {
    throw new CatalogError(
      "E_CATALOG_SIGNATURE_INVALID",
      "snapshot.signature.value must be 128 lowercase hex characters",
    );
  }

  const signingKey = keyDirectory.keys.find((k) => k.key_id === key_id);
  if (signingKey === undefined) {
    throw new CatalogError(
      "E_CATALOG_SIGNATURE_INVALID",
      `unknown signing key_id \`${key_id}\``,
    );
  }
  if (signingKey.status === "revoked") {
    throw new CatalogError(
      "E_CATALOG_SIGNATURE_INVALID",
      `signing key \`${key_id}\` is revoked`,
    );
  }
  const keyNotBeforeMs = parseUtcIsoTimestamp(
    signingKey.not_before,
    "key.not_before",
  );
  if (issuedMs < keyNotBeforeMs) {
    throw new CatalogError(
      "E_CATALOG_SIGNATURE_INVALID",
      `snapshot issued_at precedes key \`${key_id}\` not_before window`,
    );
  }
  if (signingKey.not_after !== undefined) {
    const keyNotAfterMs = parseUtcIsoTimestamp(
      signingKey.not_after,
      "key.not_after",
    );
    if (issuedMs > keyNotAfterMs) {
      throw new CatalogError(
        "E_CATALOG_SIGNATURE_INVALID",
        `snapshot issued_at is after key \`${key_id}\` not_after window`,
      );
    }
  }

  const pubKeyObj = ed25519PublicKeyFromHex(signingKey.public_key);
  const preimage = signingPreimageBytes(payloadSha256, unsignedPayload);
  const sigVerified = cryptoVerify(
    null,
    preimage,
    pubKeyObj,
    Buffer.from(sigValue, "hex"),
  );
  if (!sigVerified) {
    throw new CatalogError(
      "E_CATALOG_SIGNATURE_INVALID",
      `Ed25519 signature verification failed for key \`${key_id}\``,
    );
  }

  if (options.releaseManifests !== undefined) {
    crossCheckReleaseManifests(entries, options.releaseManifests);
  }

  return {
    ...unsignedPayload,
    payload_sha256: payloadSha256,
    signature: {
      algorithm: CATALOG_SIGNATURE_ALGORITHM,
      key_id,
      value: sigValue,
    },
  };
}

/**
 * Cross-check every catalog entry against its release `SHA256SUMS` manifest and
 * optional artifact digests. Any missing release manifest, mismatched
 * `sha256sums_sha256`, or mismatched artifact `sha256` fails closed with
 * `E_CATALOG_ARTIFACT_MISMATCH`.
 */
export function crossCheckReleaseManifests(
  entries: readonly ExtensionCatalogEntry[],
  manifests: readonly ReleaseManifestRecord[],
): void {
  const byRelease = new Map<string, Map<string, ExtensionCatalogEntry>>();
  for (const manifest of manifests) {
    const parsedEntries = parseReleaseSha256Sums(
      manifest.name,
      manifest.version,
      manifest.sha256sumsText,
      manifest.artifactDigests,
    );
    const targetMap = new Map<string, ExtensionCatalogEntry>();
    for (const item of parsedEntries) {
      targetMap.set(item.target, item);
    }
    byRelease.set(`${manifest.name}@${manifest.version}`, targetMap);
  }

  for (const entry of entries) {
    const releaseKey = `${entry.name}@${entry.version}`;
    const targetMap = byRelease.get(releaseKey);
    if (targetMap === undefined) {
      throw new CatalogError(
        "E_CATALOG_ARTIFACT_MISMATCH",
        `no release SHA256SUMS provided for catalog entry ${releaseKey}`,
      );
    }
    const expected = targetMap.get(entry.target);
    if (expected === undefined) {
      throw new CatalogError(
        "E_CATALOG_ARTIFACT_MISMATCH",
        `target \`${entry.target}\` for ${releaseKey} is absent from release SHA256SUMS`,
      );
    }
    if (entry.sha256sums_sha256 !== expected.sha256sums_sha256) {
      throw new CatalogError(
        "E_CATALOG_ARTIFACT_MISMATCH",
        `release SHA256SUMS digest mismatch for ${releaseKey} (${entry.target})`,
      );
    }
    if (entry.sha256 !== expected.sha256) {
      throw new CatalogError(
        "E_CATALOG_ARTIFACT_MISMATCH",
        `artifact sha256 mismatch for ${releaseKey} (${entry.target}): catalog has ${entry.sha256}, SHA256SUMS has ${expected.sha256}`,
      );
    }
  }
}

/**
 * Resolve an extension version and verified digest for `(name, target)`.
 *
 * - Normal path: verifies `snapshot` (when `verifyOptions` is passed) and
 *   selects either the exact requested `version` or the highest verified
 *   semver for `(name, target)`. Never guesses a "latest tag" outside the
 *   verified snapshot.
 * - Offline bootstrap path: when `snapshot` is absent and `allowSeedBootstrap`
 *   is explicitly enabled, resolves only an exact `(name, version, target)`
 *   match against `seedBootstrap`. If a `snapshot` was provided and failed
 *   verification, it fails closed and never falls back to the seed.
 */
export function resolveCatalogArtifact(
  request: ResolveCatalogRequest,
): ResolvedExtensionArtifact {
  if (!EXTENSION_NAME_PATTERN.test(request.name)) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `invalid extension name \`${request.name}\``,
    );
  }
  if (
    Buffer.byteLength(request.target, "utf8") > EXTENSION_TARGET_MAX_BYTES ||
    !EXTENSION_TARGET_PATTERN.test(request.target)
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `invalid target triple \`${request.target}\``,
    );
  }
  if (
    request.version !== undefined &&
    (!EXTENSION_VERSION_PATTERN.test(request.version) ||
      parseStrictSemver(request.version) === null)
  ) {
    throw new CatalogError(
      "E_CATALOG_INVALID_SCHEMA",
      `invalid requested version \`${request.version}\``,
    );
  }

  if (request.snapshot !== undefined) {
    const verified =
      request.verifyOptions !== undefined
        ? verifyExtensionCatalogSnapshot(
            request.snapshot,
            request.verifyOptions,
          )
        : request.snapshot;

    const candidates = verified.entries.filter(
      (e) =>
        e.name === request.name &&
        e.target === request.target &&
        (request.version === undefined || e.version === request.version),
    );
    const chosen = candidates[candidates.length - 1];
    if (chosen === undefined) {
      const verLabel =
        request.version === undefined ? "any version" : `@${request.version}`;
      throw new CatalogError(
        "E_CATALOG_NOT_FOUND",
        `no verified catalog entry for ${request.name}${verLabel} (${request.target})`,
      );
    }
    return {
      name: chosen.name,
      version: chosen.version,
      target: chosen.target,
      sha256: chosen.sha256,
      source: "catalog-snapshot",
      snapshot_version: verified.snapshot_version,
    };
  }

  if (
    request.allowSeedBootstrap === true &&
    request.seedBootstrap !== undefined
  ) {
    const seed = request.seedBootstrap;
    if (
      !EXTENSION_NAME_PATTERN.test(seed.name) ||
      !EXTENSION_VERSION_PATTERN.test(seed.version) ||
      !EXTENSION_TARGET_PATTERN.test(seed.target) ||
      !HEX_SHA256_PATTERN.test(seed.sha256)
    ) {
      throw new CatalogError(
        "E_CATALOG_INVALID_SCHEMA",
        "seed bootstrap entry is malformed",
      );
    }
    if (request.version === undefined) {
      throw new CatalogError(
        "E_CATALOG_NOT_FOUND",
        "seed bootstrap path requires an explicit `--version` (no latest selector)",
      );
    }
    if (
      seed.name !== request.name ||
      seed.version !== request.version ||
      seed.target !== request.target
    ) {
      throw new CatalogError(
        "E_CATALOG_NOT_FOUND",
        `seed bootstrap entry does not match ${request.name}@${request.version} (${request.target})`,
      );
    }
    return {
      name: seed.name,
      version: seed.version,
      target: seed.target,
      sha256: seed.sha256,
      source: "seed-bootstrap",
    };
  }

  throw new CatalogError(
    "E_CATALOG_NOT_FOUND",
    "no verified catalog snapshot available and seed bootstrap is not enabled",
  );
}

/**
 * Run a deterministic self-test proving publisher bounds, Ed25519 signing,
 * release `SHA256SUMS` cross-checking, and read-back verification.
 */
export function runCatalogSelfTest(): void {
  const { privateSeedHex, publicKeyHex } = generateEd25519KeyMaterial();
  const keyDirectory: CatalogKeyDirectory = {
    schema_version: 1,
    keys: [
      {
        key_id: "bitty-catalog-2026-11",
        algorithm: "ed25519",
        public_key: publicKeyHex,
        status: "active",
        not_before: "2026-11-01T00:00:00Z",
        not_after: "2027-11-01T00:00:00Z",
      },
    ],
  };

  const tarballHash = "a".repeat(64);
  const sha256sumsText = `${tarballHash}  x86_64-unknown-linux-gnu.tar.gz\n`;
  const entries = parseReleaseSha256Sums("net", "0.1.0", sha256sumsText, {
    "x86_64-unknown-linux-gnu": tarballHash,
  });

  const { json } = buildExtensionCatalogSnapshot({
    snapshotVersion: 1,
    issuedAt: "2026-11-10T00:00:00Z",
    expiresAt: "2026-11-11T00:00:00Z",
    entries,
    keyId: "bitty-catalog-2026-11",
    privateKey: privateSeedHex,
    keyDirectory,
  });

  const verified = verifyExtensionCatalogSnapshot(json, {
    keyDirectory,
    nowMs: Date.parse("2026-11-10T12:00:00Z"),
    minSnapshotVersion: 1,
    releaseManifests: [
      {
        name: "net",
        version: "0.1.0",
        sha256sumsText,
        artifactDigests: { "x86_64-unknown-linux-gnu": tarballHash },
      },
    ],
  });

  const resolved = resolveCatalogArtifact({
    name: "net",
    target: "x86_64-unknown-linux-gnu",
    snapshot: verified,
  });
  if (resolved.sha256 !== tarballHash || resolved.version !== "0.1.0") {
    throw new Error("catalog self-test resolution mismatch");
  }
}

function main(argv: string[]): void {
  if (argv.includes("--self-test")) {
    runCatalogSelfTest();
    console.log(
      "extension catalog snapshot self-test: PASS (build, sign, verify, SHA256SUMS cross-check, resolve)",
    );
    return;
  }

  let mode: "generate" | "verify" = "verify";
  let sourceDir = "";
  let snapshotPath = "";
  let keysPath = "";
  let outputPath = "";
  let snapshotVersion = 1;
  let issuedAt = "";
  let expiresAt = "";
  let keyId = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--generate") {
      mode = "generate";
    } else if (arg === "--verify") {
      mode = "verify";
    } else if (arg === "--source-dir") {
      sourceDir = argv[++i] ?? "";
    } else if (arg === "--snapshot") {
      snapshotPath = argv[++i] ?? "";
    } else if (arg === "--keys") {
      keysPath = argv[++i] ?? "";
    } else if (arg === "--output") {
      outputPath = argv[++i] ?? "";
    } else if (arg === "--snapshot-version") {
      snapshotVersion = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--issued-at") {
      issuedAt = argv[++i] ?? "";
    } else if (arg === "--expires-at") {
      expiresAt = argv[++i] ?? "";
    } else if (arg === "--key-id") {
      keyId = argv[++i] ?? "";
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (mode === "generate") {
    const privateKeyHex = process.env.BITTY_CATALOG_SIGNING_SEED_HEX ?? "";
    if (!privateKeyHex) {
      throw new Error(
        "BITTY_CATALOG_SIGNING_SEED_HEX is required for --generate",
      );
    }
    const { entries } = discoverLocalExtensionReleases(sourceDir);
    const keyDirectory = keysPath
      ? validateKeyDirectory(JSON.parse(readFileSync(keysPath, "utf8")))
      : undefined;
    const { json } = buildExtensionCatalogSnapshot({
      snapshotVersion,
      issuedAt,
      expiresAt,
      entries,
      keyId,
      privateKey: privateKeyHex,
      keyDirectory,
    });
    if (outputPath) {
      mkdirSync(dirname(resolve(outputPath)), { recursive: true });
      writeFileSync(outputPath, json, "utf8");
      const readBack = readFileSync(outputPath, "utf8");
      if (readBack !== json) {
        throw new Error("read-back verification failed for generated snapshot");
      }
    } else {
      process.stdout.write(json);
    }
    return;
  }

  const keyDirectory = validateKeyDirectory(
    JSON.parse(readFileSync(keysPath, "utf8")),
  );
  const rawSnapshot = readFileSync(snapshotPath, "utf8");
  const releaseManifests = sourceDir
    ? discoverLocalExtensionReleases(sourceDir).manifests
    : undefined;
  const verified = verifyExtensionCatalogSnapshot(rawSnapshot, {
    keyDirectory,
    nowMs: Date.now(),
    releaseManifests,
  });
  console.log(
    `verified extension catalog snapshot v${verified.snapshot_version} (${verified.entries.length} entries, digest ${verified.payload_sha256})`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
