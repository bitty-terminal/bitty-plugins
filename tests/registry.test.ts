import { describe, expect, test } from "bun:test";
import {
  buildIndex,
  checkLicense,
  loadEntries,
  parseIndex,
  renderIndex,
  repositoryName,
  validateEntry,
  validateRawKeys,
  validateRegistry,
  type LoadedEntry,
  type RegistryEntry,
  type RegistryIndex,
} from "../scripts/registry-lib.ts";
import { isValidVersionRange } from "../scripts/semver.ts";

const baseEntry: RegistryEntry = {
  id: "sample.plugin",
  name: "Sample Plugin",
  repository: "https://github.com/example/sample-plugin",
  kind: "plugin",
};

function loaded(
  entry: RegistryEntry,
  file = "registry/community/example-sample.toml",
  official = false,
): LoadedEntry {
  return { entry, file, official, raw: {} };
}

function errorsOf(entry: RegistryEntry): string[] {
  return validateEntry(entry, "registry/community/example-sample.toml")
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
}

describe("semver range syntax", () => {
  test("accepts comparators, caret, tilde, star, and partial versions", () => {
    for (const range of [
      ">=0.5,<1.0",
      "^0.1",
      "~1.2.3",
      "*",
      "1.2.3",
      ">= 0.5",
      "^0.1 || ^0.2",
      "1.0.0-rc.1",
    ]) {
      expect(isValidVersionRange(range)).toBe(true);
    }
  });

  test("rejects malformed ranges", () => {
    for (const range of [
      "",
      "latest",
      ">=0.5 ||",
      "1.2.3 - 2.0.0",
      "abc",
      ">=0.5,,<1.0",
    ]) {
      expect(isValidVersionRange(range)).toBe(false);
    }
  });
});

describe("SPDX license validation", () => {
  test("accepts common expressions and flags operators", () => {
    expect(checkLicense("MIT").error).toBeUndefined();
    expect(checkLicense("Apache-2.0 OR MIT").error).toBeUndefined();
    expect(checkLicense("MIT AND").error).toBeDefined();
    expect(checkLicense("MIT Apache-2.0").error).toBeDefined();
    expect(checkLicense("").error).toBeDefined();
  });

  test("warns, but does not fail, on unrecognized identifiers", () => {
    const result = checkLicense("Some-Custom-License");
    expect(result.error).toBeUndefined();
    expect(result.warnings.length).toBe(1);
  });
});

describe("entry validation", () => {
  test("accepts the minimal entry", () => {
    expect(errorsOf(baseEntry)).toEqual([]);
  });

  test("rejects missing identity, bad ids, and bad repository URLs", () => {
    expect(errorsOf({ ...baseEntry, id: "" })).toContain(
      "missing required field `id`",
    );
    expect(errorsOf({ ...baseEntry, id: "Bad_Id" }).length).toBeGreaterThan(0);
    expect(
      errorsOf({ ...baseEntry, repository: "http://example.com/a/b" }).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf({ ...baseEntry, repository: "https://example.com" }).length,
    ).toBeGreaterThan(0);
  });

  test("rejects unknown kinds and compatibility keys/ranges", () => {
    expect(
      errorsOf({ ...baseEntry, kind: "widget" as RegistryEntry["kind"] })
        .length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf({
        ...baseEntry,
        compatibility: { bitty: "not-a-range" as string },
      }).length,
    ).toBeGreaterThan(0);
  });

  test("rejects duplicate and malformed tags", () => {
    expect(errorsOf({ ...baseEntry, tags: ["a", "A"] }).length).toBeGreaterThan(
      0,
    );
    expect(errorsOf({ ...baseEntry, tags: ["a", "a"] }).length).toBeGreaterThan(
      0,
    );
  });

  test("flags unknown and derived keys, including reserved official", () => {
    const messages = validateRawKeys(
      {
        id: "sample.plugin",
        name: "Sample",
        repository: "https://github.com/example/sample-plugin",
        official: true,
        version: "1.0.0",
        stars: 3,
        mystery: true,
        compatibility: { bitty: ">=0.5", rust: "^1" },
      },
      "registry/community/example-sample.toml",
    ).map((diagnostic) => diagnostic.message);
    expect(messages.some((message) => message.includes("`official`"))).toBe(
      true,
    );
    expect(
      messages.some((message) => message.includes("derived metadata")),
    ).toBe(true);
    expect(messages.some((message) => message.includes("`mystery`"))).toBe(
      true,
    );
    expect(
      messages.some((message) => message.includes("compatibility.rust")),
    ).toBe(true);
  });
});

describe("registry-wide validation", () => {
  test("rejects duplicate ids across areas", () => {
    const diagnostics = validateRegistry([
      loaded(baseEntry, "registry/official/sample.toml", true),
      loaded(
        { ...baseEntry, name: "Other" },
        "registry/community/example-sample.toml",
      ),
    ]);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          diagnostic.message.includes("duplicate id"),
      ),
    ).toBe(true);
  });

  test("enforces community file naming and ignores official file names", () => {
    const badCommunity = validateRegistry([
      loaded(baseEntry, "registry/community/sample.toml"),
    ]);
    expect(
      badCommunity.some((diagnostic) =>
        diagnostic.message.includes("<author>-<slug>.toml"),
      ),
    ).toBe(true);
    const official = validateRegistry([
      loaded(baseEntry, "registry/official/sample.toml", true),
    ]);
    expect(
      official.filter((diagnostic) => diagnostic.severity === "error"),
    ).toEqual([]);
  });
});

describe("index generation", () => {
  const now = "2026-01-01T00:00:00Z";

  test("defaults kind, derives official, sorts by id, and normalizes arrays", () => {
    const index = buildIndex(
      [
        loaded(
          {
            ...baseEntry,
            id: "zeta.plugin",
            tags: ["b", "a", "b"],
            categories: ["utility"],
          },
          "registry/community/example-zeta.toml",
        ),
        loaded(
          { ...baseEntry, id: "alpha.plugin" },
          "registry/official/alpha.toml",
          true,
        ),
      ],
      null,
      now,
    );
    expect(index.generated_at).toBe(now);
    expect(index.plugins.map((plugin) => plugin.id)).toEqual([
      "alpha.plugin",
      "zeta.plugin",
    ]);
    expect(index.plugins[0]?.official).toBe(true);
    expect(index.plugins[1]?.official).toBe(false);
    expect(index.plugins[1]?.kind).toBe("plugin");
    expect(index.plugins[1]?.tags).toEqual(["a", "b"]);
  });

  test("is idempotent and preserves generated_at when the payload is unchanged", () => {
    const entries = [loaded(baseEntry)];
    const first = buildIndex(entries, null, now);
    const second = buildIndex(entries, first, "2030-01-01T00:00:00Z");
    expect(second.generated_at).toBe(now);
    expect(second.plugins).toEqual(first.plugins);
  });

  test("bumps generated_at when the payload changes", () => {
    const first = buildIndex([loaded(baseEntry)], null, now);
    const changed = buildIndex(
      [loaded({ ...baseEntry, name: "Renamed" })],
      first,
      "2030-01-01T00:00:00Z",
    );
    expect(changed.generated_at).toBe("2030-01-01T00:00:00Z");
  });

  test("preserves synced metadata and drops it for removed entries", () => {
    const previous: RegistryIndex = {
      schema_version: 1,
      generated_at: now,
      plugins: [
        {
          ...baseEntry,
          official: false,
          metadata: {
            version: "1.2.3",
            source: "https://example.com/manifest",
          },
        },
      ],
    };
    const kept = buildIndex([loaded(baseEntry)], previous, now);
    expect(kept.plugins[0]?.metadata?.version).toBe("1.2.3");
    const dropped = buildIndex(
      [loaded({ ...baseEntry, id: "other.plugin" })],
      previous,
      now,
    );
    expect(dropped.plugins[0]?.metadata).toBeUndefined();
  });

  test("renders canonical JSON deterministically", () => {
    const index = buildIndex([loaded(baseEntry)], null, now);
    const rendered = renderIndex(index);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered).toBe(
      renderIndex(buildIndex([loaded(baseEntry)], null, now)),
    );
    expect(parseIndex(rendered)?.plugins.length).toBe(1);
    expect(parseIndex("not json")).toBeNull();
  });

  test("derives repository names for submodule lookup", () => {
    expect(repositoryName("https://github.com/bitty-terminal/activity")).toBe(
      "activity",
    );
    expect(repositoryName("not-a-url")).toBe("");
  });
});

describe("repository registry content", () => {
  test("loads without parse errors and holds the official activity entry", () => {
    const { entries, diagnostics } = loadEntries();
    expect(diagnostics).toEqual([]);
    const activity = entries.find(
      (entry) => entry.entry.id === "bitty-featured.activity",
    );
    expect(activity).toBeDefined();
    expect(activity?.official).toBe(true);
    expect(
      validateEntry(activity?.entry as RegistryEntry, activity?.file ?? ""),
    ).toEqual([]);
    expect(validateRegistry(entries)).toEqual([]);
  });
});
