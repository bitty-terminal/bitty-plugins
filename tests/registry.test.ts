import { describe, expect, test } from "bun:test";
import {
  buildIndex,
  checkLicense,
  checkPinReachability,
  checkSubmoduleConsistency,
  collectOfficialPins,
  githubRepoSlug,
  isPinReachable,
  loadEntries,
  normalizeRepositoryUrl,
  parseGitmodules,
  parseIndex,
  renderIndex,
  repositoryName,
  validateEntry,
  validateRawKeys,
  validateRegistry,
  type LoadedEntry,
  type PinCheckPorts,
  type PinCheckRequest,
  type RegistryEntry,
  type RegistryIndex,
  type SubmoduleEntry,
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

describe("gitmodules parsing", () => {
  test("parses submodule paths, urls, and branches", () => {
    const submodules = parseGitmodules(
      [
        '[submodule "plugins/activity"]',
        "\tpath = plugins/activity",
        "\turl = https://github.com/bitty-terminal/activity",
        '[submodule "docs"]',
        "\tpath = docs",
        '\turl = "https://github.com/bitty-terminal/bitty-plugins-docs"',
        "\tbranch = main",
        "",
      ].join("\n"),
    );
    expect(submodules).toEqual([
      {
        name: "plugins/activity",
        path: "plugins/activity",
        url: "https://github.com/bitty-terminal/activity",
      },
      {
        name: "docs",
        path: "docs",
        url: "https://github.com/bitty-terminal/bitty-plugins-docs",
        branch: "main",
      },
    ]);
  });

  test("ignores other sections, comments, and sections missing path or url", () => {
    const submodules = parseGitmodules(
      [
        "# a comment",
        "; another comment",
        "[core]",
        "\trepositoryformatversion = 0",
        '[submodule "broken"]',
        "\tpath = plugins/broken",
        '[submodule "other"]',
        "\tpath = plugins/other",
        "\turl = https://example.com/other",
        "\tnot-a-key without equals",
        "malformed line",
        "",
      ].join("\n"),
    );
    expect(submodules).toEqual([
      {
        name: "other",
        path: "plugins/other",
        url: "https://example.com/other",
      },
    ]);
  });

  test("normalizes repository urls for comparison", () => {
    expect(
      normalizeRepositoryUrl("https://github.com/bitty-terminal/activity"),
    ).toBe(
      normalizeRepositoryUrl("https://github.com/bitty-terminal/activity.git"),
    );
    expect(
      normalizeRepositoryUrl("https://github.com/bitty-terminal/activity/"),
    ).toBe("https://github.com/bitty-terminal/activity");
    expect(
      normalizeRepositoryUrl("https://github.com/bitty-terminal/activity"),
    ).not.toBe(
      normalizeRepositoryUrl("https://github.com/bitty-terminal/other"),
    );
  });
});

describe("official entry to submodule mapping", () => {
  const officialEntry: RegistryEntry = {
    ...baseEntry,
    id: "example.sample",
    repository: "https://github.com/example/sample-plugin",
  };

  function officialLoaded(entry: RegistryEntry = officialEntry): LoadedEntry {
    return loaded(entry, "registry/official/sample-plugin.toml", true);
  }

  function submodule(
    path: string,
    url = "https://github.com/example/sample-plugin",
  ): SubmoduleEntry {
    return { name: path, path, url };
  }

  test("passes when entries and submodules agree", () => {
    expect(
      checkSubmoduleConsistency(
        [officialLoaded()],
        [submodule("plugins/sample-plugin")],
        ["sample-plugin"],
      ),
    ).toEqual([]);
  });

  test("accepts .git-suffixed submodule urls as the same repository", () => {
    expect(
      checkSubmoduleConsistency(
        [officialLoaded()],
        [
          submodule(
            "plugins/sample-plugin",
            "https://github.com/example/sample-plugin.git",
          ),
        ],
        [],
      ),
    ).toEqual([]);
  });

  test("errors when the submodule is missing or the url mismatches", () => {
    const missing = checkSubmoduleConsistency([officialLoaded()], [], []);
    expect(
      missing.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          diagnostic.message.includes("plugins/sample-plugin") &&
          diagnostic.message.includes(".gitmodules"),
      ),
    ).toBe(true);

    const mismatched = checkSubmoduleConsistency(
      [officialLoaded()],
      [submodule("plugins/sample-plugin", "https://github.com/example/other")],
      [],
    );
    expect(
      mismatched.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          diagnostic.message.includes("does not match"),
      ),
    ).toBe(true);
  });

  test("warns on plugin submodules and directories without an entry", () => {
    const diagnostics = checkSubmoduleConsistency(
      [officialLoaded()],
      [
        submodule("plugins/sample-plugin"),
        submodule("plugins/orphan", "https://github.com/example/orphan"),
      ],
      ["sample-plugin", "stray-dir"],
    );
    const warnings = diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    );
    expect(
      warnings.some((diagnostic) =>
        diagnostic.message.includes("plugins/orphan"),
      ),
    ).toBe(true);
    expect(
      warnings.some((diagnostic) =>
        diagnostic.message.includes("plugins/stray-dir"),
      ),
    ).toBe(true);
    expect(
      warnings.some((diagnostic) =>
        diagnostic.message.includes("plugins/sample-plugin"),
      ),
    ).toBe(false);
    expect(
      diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    ).toBe(false);
  });

  test("ignores community entries, non-plugin submodules, and bad urls", () => {
    expect(
      checkSubmoduleConsistency(
        [loaded(baseEntry)],
        [submodule("sdk"), submodule("docs")],
        [],
      ),
    ).toEqual([]);
    expect(
      checkSubmoduleConsistency(
        [officialLoaded({ ...officialEntry, repository: "not-a-url" })],
        [],
        [],
      ),
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

describe("submodule pin mainline reachability", () => {
  const request: PinCheckRequest = {
    name: "sample-plugin",
    pin: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repository: "https://github.com/example/sample-plugin",
    file: "registry/official/sample-plugin.toml",
  };
  const tip = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function portsWith(
    compare: PinCheckPorts["comparePinToTip"],
    tipValue: string | null = tip,
  ): PinCheckPorts {
    return {
      resolveDefaultTip: async () => tipValue,
      comparePinToTip: compare,
    };
  }

  test("parses github slugs and rejects other hosts", () => {
    expect(
      githubRepoSlug("https://github.com/bitty-terminal/activity"),
    ).toEqual({ owner: "bitty-terminal", repo: "activity" });
    expect(
      githubRepoSlug("https://github.com/bitty-terminal/activity.git"),
    ).toEqual({ owner: "bitty-terminal", repo: "activity" });
    expect(githubRepoSlug("https://gitlab.com/owner/repo")).toBeNull();
    expect(githubRepoSlug("https://github.com/owner")).toBeNull();
    expect(githubRepoSlug("not-a-url")).toBeNull();
  });

  test("ahead and identical prove reachability, behind and diverged do not", () => {
    expect(isPinReachable("ahead")).toBe(true);
    expect(isPinReachable("identical")).toBe(true);
    expect(isPinReachable("behind")).toBe(false);
    expect(isPinReachable("diverged")).toBe(false);
  });

  test("collects only official entries with a matching submodule", () => {
    const official = loaded(
      { ...baseEntry, repository: "https://github.com/example/sample-plugin" },
      "registry/official/sample-plugin.toml",
      true,
    );
    expect(
      collectOfficialPins(
        [official, loaded(baseEntry)],
        [
          {
            name: "x",
            path: "plugins/sample-plugin",
            url: "https://github.com/example/sample-plugin",
          },
        ],
      ),
    ).toEqual([
      {
        name: "sample-plugin",
        pin: "",
        repository: "https://github.com/example/sample-plugin",
        file: "registry/official/sample-plugin.toml",
      },
    ]);
    expect(collectOfficialPins([official], [])).toEqual([]);
  });

  test("passes reachable pins and skips the compare call when pin is the tip", () => {
    let calls = 0;
    return (async () => {
      const outcome = await checkPinReachability(
        [{ ...request, pin: tip }],
        portsWith(async () => {
          calls += 1;
          return { status: "ahead" };
        }),
        60000,
      );
      expect(outcome).toEqual({ diagnostics: [], notices: [], halted: false });
      expect(calls).toBe(0);
    })();
  });

  test("fails unreachable and unknown pins", () => {
    return (async () => {
      for (const status of ["behind", "diverged"] as const) {
        const outcome = await checkPinReachability(
          [request],
          portsWith(async () => ({ status })),
          60000,
        );
        expect(outcome.halted).toBe(false);
        expect(outcome.diagnostics.length).toBe(1);
        expect(outcome.diagnostics[0]?.severity).toBe("error");
        expect(outcome.diagnostics[0]?.message).toContain("not reachable");
      }
      const missing = await checkPinReachability(
        [request],
        portsWith(async () => ({ httpStatus: 404 })),
        60000,
      );
      expect(missing.diagnostics.length).toBe(1);
      expect(missing.diagnostics[0]?.severity).toBe("error");
      expect(missing.diagnostics[0]?.message).toContain("was not found");
    })();
  });

  test("warns on unexpected http failures without halting", () => {
    return (async () => {
      const outcome = await checkPinReachability(
        [request, { ...request, name: "other" }],
        portsWith(async () => ({ httpStatus: 500 })),
        60000,
      );
      expect(outcome.halted).toBe(false);
      expect(
        outcome.diagnostics.every(
          (diagnostic) => diagnostic.severity === "warning",
        ),
      ).toBe(true);
      expect(outcome.diagnostics.length).toBe(2);
    })();
  });

  test("halts gracefully offline with a notice and no diagnostics", () => {
    return (async () => {
      const throwing: PinCheckPorts = {
        resolveDefaultTip: async () => {
          throw new Error("fetch failed");
        },
        comparePinToTip: async () => ({ status: "ahead" }),
      };
      const offline = await checkPinReachability([request], throwing, 60000);
      expect(offline.halted).toBe(true);
      expect(offline.diagnostics).toEqual([]);
      expect(
        offline.notices.some((notice) =>
          notice.includes("network unavailable"),
        ),
      ).toBe(true);

      const unreachableTip = await checkPinReachability(
        [request],
        portsWith(async () => ({ status: "ahead" }), null),
        60000,
      );
      expect(unreachableTip.halted).toBe(true);
      expect(unreachableTip.diagnostics).toEqual([]);

      const compareDown: PinCheckPorts = {
        resolveDefaultTip: async () => tip,
        comparePinToTip: async () => {
          throw new Error("connection reset");
        },
      };
      const compareOffline = await checkPinReachability(
        [request],
        compareDown,
        60000,
      );
      expect(compareOffline.halted).toBe(true);
      expect(compareOffline.diagnostics).toEqual([]);
    })();
  });

  test("skips unsupported hosts with a notice", () => {
    return (async () => {
      const outcome = await checkPinReachability(
        [{ ...request, repository: "https://gitlab.com/owner/repo" }],
        portsWith(async () => ({ status: "ahead" })),
        60000,
      );
      expect(outcome).toEqual({
        diagnostics: [],
        notices: [
          "notice: registry/official/sample-plugin.toml: pin reachability is not supported for this host; skipping",
        ],
        halted: false,
      });
    })();
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
