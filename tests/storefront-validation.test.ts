/**
 * Storefront UI validation tests (PLUG-REG-002)
 *
 * Tests validate that all optional registry data fields consumed by rendering
 * are properly validated before use, ensuring invalid shapes cannot abort
 * rendering or search.
 */

import { describe, expect, test } from "bun:test";
import { isRegistry } from "../app/src/registry.ts";
import type { Plugin, Registry } from "../app/src/registry.ts";

const basePlugin: Plugin = {
  id: "test.plugin",
  name: "Test Plugin",
  kind: "plugin",
  repository: "https://github.com/example/test",
  official: false,
};

describe("isRegistry validates optional fields consumed by rendering", () => {
  test("accepts minimal valid registry", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [basePlugin],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts registry with all optional string fields", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          author: "Test Author",
          description: "A test plugin",
          license: "MIT",
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts registry with valid tags array", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          tags: ["productivity", "editor"],
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts registry with valid categories array", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          categories: ["development", "tools"],
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts registry with valid compatibility object", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {
            bitty: ">=0.1.0",
            sdk: "^1.0.0",
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts registry with valid metadata object", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            version: "1.0.0",
            description: "Test description",
            license: "MIT",
            source: "https://example.com/manifest.toml",
            fetched_at: "2024-01-01T00:00:00Z",
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("rejects plugin with non-string author", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          author: 123,
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with non-string description", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          description: true,
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with non-string license", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          license: [],
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with non-array tags", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          tags: "not-an-array",
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with tags array containing non-strings", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          tags: ["valid", 123, "also-valid"],
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with non-array categories", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          categories: { not: "array" },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with categories array containing non-strings", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          categories: ["valid", null, "also-valid"],
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with non-object compatibility", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: "not-an-object",
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with compatibility.bitty as non-string", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {
            bitty: 123,
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with compatibility.sdk as non-string", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {
            sdk: true,
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with non-string manifest_hash", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          manifest_hash: 12345,
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with non-object metadata", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: "not-an-object",
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with metadata.version as non-string", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            version: 1.0,
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with metadata.description as non-string", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            description: [],
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with metadata.license as non-string", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            license: { type: "MIT" },
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with metadata.source as non-string", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            source: 123,
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects plugin with metadata.fetched_at as non-string", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            fetched_at: new Date(),
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("accepts empty tags and categories arrays", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          tags: [],
          categories: [],
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts compatibility with only bitty field", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {
            bitty: ">=0.1.0",
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts compatibility with only sdk field", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {
            sdk: "^1.0.0",
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts empty compatibility object", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {},
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts empty metadata object", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {},
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("accepts signature_status values", () => {
    for (const status of ["verified", "unverified", "unsigned"] as const) {
      const registry = {
        schema_version: 1,
        generated_at: "2024-01-01T00:00:00Z",
        plugins: [
          {
            ...basePlugin,
            signature_status: status,
          },
        ],
      };
      expect(isRegistry(registry)).toBe(true);
    }
  });

  test("rejects invalid signature_status", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          signature_status: "invalid",
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects multiple malformed plugins in array", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        basePlugin,
        {
          ...basePlugin,
          id: "malformed.plugin",
          tags: "not-an-array",
        },
        {
          ...basePlugin,
          id: "another.plugin",
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("validates all plugins in array before accepting", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        basePlugin,
        {
          ...basePlugin,
          id: "valid.plugin",
          tags: ["tag1", "tag2"],
          categories: ["cat1"],
        },
        {
          ...basePlugin,
          id: "also-valid.plugin",
          metadata: {
            version: "1.0.0",
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });
});

describe("graceful degradation for invalid optional fields", () => {
  test("validation prevents rendering crashes from malformed tags", () => {
    // plugin-card.ts:78-82 and plugin-detail.ts:105-107 assume tags is an array
    const malformedRegistry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          tags: "should-be-array",
        },
      ],
    };
    expect(isRegistry(malformedRegistry)).toBe(false);
  });

  test("validation prevents rendering crashes from malformed categories", () => {
    // plugin-detail.ts:92-104 and registry.ts:146-150 assume categories is an array
    const malformedRegistry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          categories: 123,
        },
      ],
    };
    expect(isRegistry(malformedRegistry)).toBe(false);
  });

  test("validation prevents search crashes from malformed optional fields", () => {
    // search.ts:43-52 assumes author, categories, tags, description are correct types
    const malformedRegistry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          author: 123,
          description: [],
          tags: "string",
          categories: { not: "array" },
        },
      ],
    };
    expect(isRegistry(malformedRegistry)).toBe(false);
  });

  test("validation prevents crashes from malformed metadata.version", () => {
    // plugin-card.ts:75 and plugin-detail.ts:22-24 access metadata.version
    const malformedRegistry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            version: 123,
          },
        },
      ],
    };
    expect(isRegistry(malformedRegistry)).toBe(false);
  });

  test("validation prevents crashes from malformed compatibility", () => {
    // plugin-detail.ts:82-91 accesses compatibility.bitty and compatibility.sdk
    const malformedRegistry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {
            bitty: 123,
            sdk: true,
          },
        },
      ],
    };
    expect(isRegistry(malformedRegistry)).toBe(false);
  });
});

describe("edge cases and boundary conditions", () => {
  test("accepts null compatibility fields as missing", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          compatibility: {
            bitty: null,
            sdk: null,
          },
        },
      ],
    };
    // null is not a string, so this should be rejected
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects undefined in string array positions", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          tags: ["valid", undefined, "also-valid"],
        },
      ],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("validates deeply nested metadata fields", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          metadata: {
            version: "1.0.0",
            description: "Valid",
            license: "MIT",
            source: "https://example.com",
            fetched_at: "2024-01-01T00:00:00Z",
          },
        },
      ],
    };
    expect(isRegistry(registry)).toBe(true);
  });

  test("rejects registry with non-array plugins", () => {
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: "not-an-array",
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects registry with missing schema_version", () => {
    const registry = {
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [basePlugin],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("rejects registry with missing generated_at", () => {
    const registry = {
      schema_version: 1,
      plugins: [basePlugin],
    };
    expect(isRegistry(registry)).toBe(false);
  });

  test("accepts registry with extra unknown fields at plugin level", () => {
    // Unknown fields at plugin level should be ignored, not rejected
    const registry = {
      schema_version: 1,
      generated_at: "2024-01-01T00:00:00Z",
      plugins: [
        {
          ...basePlugin,
          unknownField: "ignored",
        },
      ],
    };
    // The type guard only validates known fields
    expect(isRegistry(registry)).toBe(true);
  });
});
