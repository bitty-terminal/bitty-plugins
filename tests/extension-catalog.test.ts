import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildExtensionCatalogSnapshot,
  CATALOG_MAX_BYTES,
  CATALOG_MAX_ENTRIES,
  CATALOG_MAX_TTL_MS,
  CatalogError,
  type CatalogKeyDirectory,
  discoverLocalExtensionReleases,
  type ExtensionCatalogEntry,
  generateEd25519KeyMaterial,
  parseReleaseSha256Sums,
  resolveCatalogArtifact,
  runCatalogSelfTest,
  sha256Hex,
  verifyExtensionCatalogSnapshot,
} from "../scripts/extension-catalog.ts";

function makeFixtureKeys() {
  const active = generateEd25519KeyMaterial();
  const retired = generateEd25519KeyMaterial();
  const revoked = generateEd25519KeyMaterial();

  const keyDirectory: CatalogKeyDirectory = {
    schema_version: 1,
    keys: [
      {
        key_id: "bitty-catalog-2026-11",
        algorithm: "ed25519",
        public_key: active.publicKeyHex,
        status: "active",
        not_before: "2026-11-01T00:00:00Z",
        not_after: "2027-11-01T00:00:00Z",
      },
      {
        key_id: "bitty-catalog-2026-05",
        algorithm: "ed25519",
        public_key: retired.publicKeyHex,
        status: "retired",
        not_before: "2026-05-01T00:00:00Z",
        not_after: "2026-12-01T00:00:00Z",
      },
      {
        key_id: "bitty-catalog-compromised",
        algorithm: "ed25519",
        public_key: revoked.publicKeyHex,
        status: "revoked",
        not_before: "2026-01-01T00:00:00Z",
        not_after: "2027-01-01T00:00:00Z",
      },
    ],
  };

  return { active, retired, revoked, keyDirectory };
}

function makeSampleEntries(): {
  entries: ExtensionCatalogEntry[];
  sha256sumsV1: string;
  sha256sumsV2: string;
  linuxHashV1: string;
  macHashV1: string;
  linuxHashV2: string;
} {
  const linuxHashV1 = "11".repeat(32);
  const macHashV1 = "22".repeat(32);
  const linuxHashV2 = "33".repeat(32);

  const sha256sumsV1 = [
    `${linuxHashV1}  x86_64-unknown-linux-gnu.tar.gz`,
    `${macHashV1}  aarch64-apple-darwin.tar.gz`,
    "",
  ].join("\n");
  const sha256sumsV2 = `${linuxHashV2}  x86_64-unknown-linux-gnu.tar.gz\n`;

  const entries = [
    ...parseReleaseSha256Sums("net", "0.1.0", sha256sumsV1, {
      "x86_64-unknown-linux-gnu": linuxHashV1,
      "aarch64-apple-darwin": macHashV1,
    }),
    ...parseReleaseSha256Sums("net", "0.2.0", sha256sumsV2, {
      "x86_64-unknown-linux-gnu": linuxHashV2,
    }),
  ];

  return {
    entries,
    sha256sumsV1,
    sha256sumsV2,
    linuxHashV1,
    macHashV1,
    linuxHashV2,
  };
}

describe("extension catalog snapshot contract (bitty-plugins#121)", () => {
  test("self-test executes end-to-end build, sign, verify, and resolve", () => {
    expect(() => runCatalogSelfTest()).not.toThrow();
  });

  test("builds, signs, verifies, and cross-checks a valid snapshot against release SHA256SUMS", () => {
    const { active, keyDirectory } = makeFixtureKeys();
    const {
      entries,
      sha256sumsV1,
      sha256sumsV2,
      linuxHashV1,
      macHashV1,
      linuxHashV2,
    } = makeSampleEntries();

    const { snapshot, json } = buildExtensionCatalogSnapshot({
      snapshotVersion: 7,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-12T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });

    const verified = verifyExtensionCatalogSnapshot(json, {
      keyDirectory,
      nowMs: Date.parse("2026-11-10T06:00:00Z"),
      minSnapshotVersion: 7,
      acceptedSnapshotDigest: snapshot.payload_sha256,
      releaseManifests: [
        {
          name: "net",
          version: "0.1.0",
          sha256sumsText: sha256sumsV1,
          artifactDigests: {
            "x86_64-unknown-linux-gnu": linuxHashV1,
            "aarch64-apple-darwin": macHashV1,
          },
        },
        {
          name: "net",
          version: "0.2.0",
          sha256sumsText: sha256sumsV2,
          artifactDigests: {
            "x86_64-unknown-linux-gnu": linuxHashV2,
          },
        },
      ],
    });

    expect(verified.snapshot_version).toBe(7);
    expect(verified.entries).toHaveLength(3);

    // Highest verified semver selected when version is omitted.
    const latestLinux = resolveCatalogArtifact({
      name: "net",
      target: "x86_64-unknown-linux-gnu",
      snapshot: verified,
    });
    expect(latestLinux).toEqual({
      name: "net",
      version: "0.2.0",
      target: "x86_64-unknown-linux-gnu",
      sha256: linuxHashV2,
      source: "catalog-snapshot",
      snapshot_version: 7,
    });

    // Exact pinned version selected when specified.
    const pinnedLinux = resolveCatalogArtifact({
      name: "net",
      version: "0.1.0",
      target: "x86_64-unknown-linux-gnu",
      snapshot: verified,
    });
    expect(pinnedLinux.version).toBe("0.1.0");
    expect(pinnedLinux.sha256).toBe(linuxHashV1);
  });

  test("rejects unknown fields at snapshot root, entry, signature, and key directory levels", () => {
    const { active, keyDirectory } = makeFixtureKeys();
    const { entries } = makeSampleEntries();
    const { snapshot } = buildExtensionCatalogSnapshot({
      snapshotVersion: 1,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });
    const nowMs = Date.parse("2026-11-10T01:00:00Z");

    expect(() =>
      verifyExtensionCatalogSnapshot(
        { ...snapshot, extra_root: true },
        { keyDirectory, nowMs },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_UNKNOWN_FIELD" }),
    );

    expect(() =>
      verifyExtensionCatalogSnapshot(
        {
          ...snapshot,
          entries: [{ ...snapshot.entries[0], unexpected: "x" }],
        },
        { keyDirectory, nowMs },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_UNKNOWN_FIELD" }),
    );

    expect(() =>
      verifyExtensionCatalogSnapshot(
        {
          ...snapshot,
          signature: { ...snapshot.signature, extra_sig: "1" },
        },
        { keyDirectory, nowMs },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_UNKNOWN_FIELD" }),
    );

    expect(() =>
      verifyExtensionCatalogSnapshot(snapshot, {
        keyDirectory: {
          ...keyDirectory,
          extra_dir_field: 1,
        } as unknown as CatalogKeyDirectory,
        nowMs,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_UNKNOWN_FIELD" }),
    );
  });

  test("rejects unsigned snapshots with E_CATALOG_UNSIGNED", () => {
    const { active, keyDirectory } = makeFixtureKeys();
    const { entries } = makeSampleEntries();
    const { snapshot } = buildExtensionCatalogSnapshot({
      snapshotVersion: 1,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });
    const nowMs = Date.parse("2026-11-10T01:00:00Z");

    const withoutSig = { ...snapshot, signature: undefined };
    expect(() =>
      verifyExtensionCatalogSnapshot(withoutSig, { keyDirectory, nowMs }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_UNSIGNED" }));

    const emptySig = {
      ...snapshot,
      signature: { ...snapshot.signature, value: "" },
    };
    expect(() =>
      verifyExtensionCatalogSnapshot(emptySig, { keyDirectory, nowMs }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_UNSIGNED" }));
  });

  test("rejects tampered payload bytes with E_CATALOG_DIGEST_MISMATCH and invalid signatures with E_CATALOG_SIGNATURE_INVALID", () => {
    const { active, retired, revoked, keyDirectory } = makeFixtureKeys();
    const { entries } = makeSampleEntries();
    const { snapshot } = buildExtensionCatalogSnapshot({
      snapshotVersion: 2,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });
    const nowMs = Date.parse("2026-11-10T01:00:00Z");

    // Mutate an entry digest without updating payload_sha256 -> E_CATALOG_DIGEST_MISMATCH
    const mutatedEntry = {
      ...snapshot,
      entries: snapshot.entries.map((e, idx) =>
        idx === 0 ? { ...e, sha256: "f".repeat(64) } : e,
      ),
    };
    expect(() =>
      verifyExtensionCatalogSnapshot(mutatedEntry, { keyDirectory, nowMs }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_DIGEST_MISMATCH" }),
    );

    // Flip first byte of signature -> E_CATALOG_SIGNATURE_INVALID
    const flippedFirstChar = snapshot.signature.value.startsWith("0")
      ? "1"
      : "0";
    const badSig = {
      ...snapshot,
      signature: {
        ...snapshot.signature,
        value: flippedFirstChar + snapshot.signature.value.slice(1),
      },
    };
    expect(() =>
      verifyExtensionCatalogSnapshot(badSig, { keyDirectory, nowMs }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_SIGNATURE_INVALID" }),
    );

    // Key rotation: snapshot signed by `retired` key within its validity window is accepted by reader,
    // but publisher refuses to sign new snapshots with a `retired` key when keyDirectory is passed.
    expect(() =>
      buildExtensionCatalogSnapshot({
        snapshotVersion: 2,
        issuedAt: "2026-11-10T00:00:00Z",
        expiresAt: "2026-11-11T00:00:00Z",
        entries,
        keyId: "bitty-catalog-2026-05",
        privateKey: retired.privateSeedHex,
        keyDirectory,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_SIGNATURE_INVALID" }),
    );

    const retiredSnapshot = buildExtensionCatalogSnapshot({
      snapshotVersion: 2,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-05",
      privateKey: retired.privateSeedHex,
    });
    expect(
      verifyExtensionCatalogSnapshot(retiredSnapshot.json, {
        keyDirectory,
        nowMs,
      }).snapshot_version,
    ).toBe(2);

    // Snapshot signed by `revoked` key is rejected by reader immediately.
    const revokedSnapshot = buildExtensionCatalogSnapshot({
      snapshotVersion: 3,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-compromised",
      privateKey: revoked.privateSeedHex,
    });
    expect(() =>
      verifyExtensionCatalogSnapshot(revokedSnapshot.json, {
        keyDirectory,
        nowMs,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_SIGNATURE_INVALID" }),
    );
  });

  test("rejects expired, future-skewed, and excessive-TTL snapshots with E_CATALOG_STALE", () => {
    const { active, keyDirectory } = makeFixtureKeys();
    const { entries } = makeSampleEntries();

    // Publisher rejects TTL > CATALOG_MAX_TTL_MS (7 days)
    expect(() =>
      buildExtensionCatalogSnapshot({
        snapshotVersion: 1,
        issuedAt: "2026-11-01T00:00:00Z",
        expiresAt: "2026-11-15T00:00:00Z",
        entries,
        keyId: "bitty-catalog-2026-11",
        privateKey: active.privateSeedHex,
        keyDirectory,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_STALE" }));

    const { json } = buildExtensionCatalogSnapshot({
      snapshotVersion: 1,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });

    // Expired snapshot (nowMs > expires_at)
    expect(() =>
      verifyExtensionCatalogSnapshot(json, {
        keyDirectory,
        nowMs: Date.parse("2026-11-11T00:00:01Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_STALE" }));

    // Future issued_at beyond 5-minute skew
    expect(() =>
      verifyExtensionCatalogSnapshot(json, {
        keyDirectory,
        nowMs: Date.parse("2026-11-09T23:50:00Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_STALE" }));

    // Sanity check constant bound
    expect(CATALOG_MAX_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("rejects downgrade and divergent same-version replay with E_CATALOG_DOWNGRADE", () => {
    const { active, keyDirectory } = makeFixtureKeys();
    const { entries } = makeSampleEntries();

    const v4 = buildExtensionCatalogSnapshot({
      snapshotVersion: 4,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });

    const v5 = buildExtensionCatalogSnapshot({
      snapshotVersion: 5,
      issuedAt: "2026-11-10T01:00:00Z",
      expiresAt: "2026-11-11T01:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });

    const nowMs = Date.parse("2026-11-10T02:00:00Z");

    // Older snapshot_version < minSnapshotVersion -> E_CATALOG_DOWNGRADE
    expect(() =>
      verifyExtensionCatalogSnapshot(v4.json, {
        keyDirectory,
        nowMs,
        minSnapshotVersion: 5,
        acceptedSnapshotDigest: v5.snapshot.payload_sha256,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_DOWNGRADE" }));

    // Same snapshot_version (5) but different payload_sha256 -> E_CATALOG_DOWNGRADE
    const v5Divergent = buildExtensionCatalogSnapshot({
      snapshotVersion: 5,
      issuedAt: "2026-11-10T01:30:00Z",
      expiresAt: "2026-11-11T01:30:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });
    expect(() =>
      verifyExtensionCatalogSnapshot(v5Divergent.json, {
        keyDirectory,
        nowMs,
        minSnapshotVersion: 5,
        acceptedSnapshotDigest: v5.snapshot.payload_sha256,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_DOWNGRADE" }));
  });

  test("enforces size and count bounds in both publisher and reader with E_CATALOG_OVERSIZED", () => {
    const { active, keyDirectory } = makeFixtureKeys();
    const { entries } = makeSampleEntries();

    // Oversized entry count (> CATALOG_MAX_ENTRIES) rejected by publisher
    const tooManyEntries: ExtensionCatalogEntry[] = [];
    for (let i = 0; i <= CATALOG_MAX_ENTRIES; i++) {
      tooManyEntries.push({
        name: "net",
        version: `0.${Math.floor(i / 100)}.${i % 100}`,
        target: "x86_64-unknown-linux-gnu",
        sha256: "a".repeat(64),
        sha256sums_sha256: "b".repeat(64),
      });
    }
    expect(() =>
      buildExtensionCatalogSnapshot({
        snapshotVersion: 1,
        issuedAt: "2026-11-10T00:00:00Z",
        expiresAt: "2026-11-11T00:00:00Z",
        entries: tooManyEntries,
        keyId: "bitty-catalog-2026-11",
        privateKey: active.privateSeedHex,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_OVERSIZED" }));

    // Oversized raw JSON (> CATALOG_MAX_BYTES) rejected by reader before parsing
    const hugeJson = `${" ".repeat(CATALOG_MAX_BYTES + 1)}{}`;
    expect(() =>
      verifyExtensionCatalogSnapshot(hugeJson, {
        keyDirectory,
        nowMs: Date.parse("2026-11-10T01:00:00Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_OVERSIZED" }));

    // Empty entries rejected without allowEmpty
    expect(() =>
      buildExtensionCatalogSnapshot({
        snapshotVersion: 1,
        issuedAt: "2026-11-10T00:00:00Z",
        expiresAt: "2026-11-11T00:00:00Z",
        entries: [],
        keyId: "bitty-catalog-2026-11",
        privateKey: active.privateSeedHex,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_INVALID_SCHEMA" }),
    );
    expect(entries.length).toBeGreaterThan(0);
  });

  test("rejects artifact digest and SHA256SUMS mismatches with E_CATALOG_ARTIFACT_MISMATCH", () => {
    const { active, keyDirectory } = makeFixtureKeys();
    const { entries, sha256sumsV1, sha256sumsV2, macHashV1, linuxHashV2 } =
      makeSampleEntries();

    const { json } = buildExtensionCatalogSnapshot({
      snapshotVersion: 1,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });

    // Wrong tarball digest in release artifactDigests -> E_CATALOG_ARTIFACT_MISMATCH
    expect(() =>
      verifyExtensionCatalogSnapshot(json, {
        keyDirectory,
        nowMs: Date.parse("2026-11-10T01:00:00Z"),
        releaseManifests: [
          {
            name: "net",
            version: "0.1.0",
            sha256sumsText: sha256sumsV1,
            artifactDigests: {
              "x86_64-unknown-linux-gnu": "f".repeat(64),
              "aarch64-apple-darwin": macHashV1,
            },
          },
          {
            name: "net",
            version: "0.2.0",
            sha256sumsText: sha256sumsV2,
            artifactDigests: {
              "x86_64-unknown-linux-gnu": linuxHashV2,
            },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_ARTIFACT_MISMATCH" }),
    );

    // Missing release SHA256SUMS for 0.2.0 -> E_CATALOG_ARTIFACT_MISMATCH
    expect(() =>
      verifyExtensionCatalogSnapshot(json, {
        keyDirectory,
        nowMs: Date.parse("2026-11-10T01:00:00Z"),
        releaseManifests: [
          {
            name: "net",
            version: "0.1.0",
            sha256sumsText: sha256sumsV1,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "E_CATALOG_ARTIFACT_MISMATCH" }),
    );
  });

  test("discovers local release directories and verifies tarball digests on disk", () => {
    mkdirSync("/tmp/bitty", { recursive: true });
    const tempRoot = mkdtempSync("/tmp/bitty/catalog-test-");
    try {
      const releaseDir = join(tempRoot, "net", "0.1.0");
      mkdirSync(releaseDir, { recursive: true });
      const tarballBytes = Buffer.from("bitty-net-0.1.0-linux-archive", "utf8");
      const tarballDigest = sha256Hex(tarballBytes);
      writeFileSync(
        join(releaseDir, "x86_64-unknown-linux-gnu.tar.gz"),
        tarballBytes,
      );
      writeFileSync(
        join(releaseDir, "SHA256SUMS"),
        `${tarballDigest}  x86_64-unknown-linux-gnu.tar.gz\n`,
        "utf8",
      );

      const discovered = discoverLocalExtensionReleases(tempRoot);
      expect(discovered.entries).toHaveLength(1);
      expect(discovered.entries[0]?.sha256).toBe(tarballDigest);

      // Corrupt the tarball on disk -> E_CATALOG_ARTIFACT_MISMATCH
      writeFileSync(
        join(releaseDir, "x86_64-unknown-linux-gnu.tar.gz"),
        Buffer.from("corrupted-bytes", "utf8"),
      );
      expect(() => discoverLocalExtensionReleases(tempRoot)).toThrowError(
        expect.objectContaining({ code: "E_CATALOG_ARTIFACT_MISMATCH" }),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("preserves offline seed bootstrap only with exact --version and never falls back on failed snapshot", () => {
    const seed = {
      name: "net",
      version: "0.1.0",
      target: "x86_64-unknown-linux-gnu",
      sha256: "11".repeat(32),
    };

    // Offline bootstrap without version (latest guessing) is refused.
    expect(() =>
      resolveCatalogArtifact({
        name: "net",
        target: "x86_64-unknown-linux-gnu",
        seedBootstrap: seed,
        allowSeedBootstrap: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_CATALOG_NOT_FOUND" }));

    // Offline bootstrap with exact matching version succeeds when no snapshot is present.
    const resolvedSeed = resolveCatalogArtifact({
      name: "net",
      version: "0.1.0",
      target: "x86_64-unknown-linux-gnu",
      seedBootstrap: seed,
      allowSeedBootstrap: true,
    });
    expect(resolvedSeed).toEqual({
      name: "net",
      version: "0.1.0",
      target: "x86_64-unknown-linux-gnu",
      sha256: seed.sha256,
      source: "seed-bootstrap",
    });

    // When a snapshot is provided and fails verification, it fails closed and never falls back to seed.
    const { active, keyDirectory } = makeFixtureKeys();
    const { entries } = makeSampleEntries();
    const { snapshot } = buildExtensionCatalogSnapshot({
      snapshotVersion: 1,
      issuedAt: "2026-11-10T00:00:00Z",
      expiresAt: "2026-11-11T00:00:00Z",
      entries,
      keyId: "bitty-catalog-2026-11",
      privateKey: active.privateSeedHex,
      keyDirectory,
    });

    expect(() =>
      resolveCatalogArtifact({
        name: "net",
        version: "0.1.0",
        target: "x86_64-unknown-linux-gnu",
        snapshot,
        verifyOptions: {
          keyDirectory,
          nowMs: Date.parse("2026-11-15T00:00:00Z"), // expired
        },
        seedBootstrap: seed,
        allowSeedBootstrap: true,
      }),
    ).toThrowError(CatalogError);
  });
});
