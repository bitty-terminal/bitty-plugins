# Bitty Plugins

Official plugin directory, registry, and store frontend for the Bitty
ecosystem.

- Canonical repository:
  [bitty-terminal/bitty-plugins](https://github.com/bitty-terminal/bitty-plugins)

## Production URLs

| Surface               | URL                         | Owner                    |
| --------------------- | --------------------------- | ------------------------ |
| Product website       | <https://bitty.run>         | `bitty-website` (Astro)  |
| Plugin registry/store | <https://plugins.bitty.run> | this repository (`app/`) |

The `bitty.run` domain was registered on 2026-09-14; Cloudflare verification
may still be pending. The organization-level Cloudflare variables
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` exist for CI/CD, but the
`bitty-plugins` Cloudflare Pages project and the `plugins.bitty.run` custom
domain must still be provisioned before `deploy.yml` can publish. No
credentials are committed to the repository.

This repository is pre-implementation. The registry format, validation,
generation, and the static store prototype exist; the `bitty plugin add <id>`
install flow is a **design proposal** documented here, not implemented
behavior. Do not describe the store or CLI as shipped product behavior.

## What this repository owns

| Path         | Responsibility                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `registry/`  | Machine-readable registry entries (official and community), plus the entry schema.                                                |
| `generated/` | Built artifacts consumed by downstream clients; only `registry.json` today.                                                       |
| `app/`       | Static store frontend (Vite + TypeScript, vanilla DOM / Web Components, no framework).                                            |
| `plugins/`   | Official maintained plugins as pinned Git submodules (known-good set).                                                            |
| `sdk/`       | Submodule: [bitty-plugin-sdk](https://github.com/bitty-terminal/bitty-plugin-sdk).                                                |
| `template/`  | Submodule: [bitty-plugin-template](https://github.com/bitty-terminal/bitty-plugin-template).                                      |
| `docs/`      | Submodule: [bitty-plugins-docs](https://github.com/bitty-terminal/bitty-plugins-docs) — canonical plugin-ecosystem documentation. |
| `scripts/`   | Registry validation, index generation, and metadata synchronization.                                                              |

This repository does **not** own the terminal core or plugin host (`bitty`),
canonical specification text (shared governance in `bitty-docs`; the
plugin-ecosystem corpus mounted at `docs/` from `bitty-plugins-docs`), or the
SDK and template implementations (their own repositories).

## Official versus community boundary (fixed)

- **Official plugins** live in `plugins/` as pinned submodules. An update is a
  submodule pointer bump reviewed like any other change; the directory is the
  known-good set maintained by `bitty-terminal`.
- **Community plugins are never submodules.** They live only as registry
  entries at `registry/community/<author>-<slug>.toml`, one file per plugin, in
  a machine-readable awesome-list model. This repository never clones or pins
  community code.
- Official entries live at `registry/official/<name>.toml` and are marked
  `official: true` in the generated index. The distinction is derived from the
  entry location, never declared inside the entry.

## Maintaining the registry

The canonical rules live in the
[official plugin onboarding policy](https://github.com/bitty-terminal/bitty-plugins-docs/blob/main/product/official-plugin-onboarding.md)
in `bitty-plugins-docs` (the mounted `docs/` copy updates at the next submodule
bump). Maintainers run the same mechanical steps:

1. Edit or add the entry under `registry/official/` or `registry/community/`;
   entries stay minimal and `generated/registry.json` is never hand-edited.
2. Regenerate the index: `just registry-generate`.
3. Validate entries (schema, duplicate ids, repository URLs, licenses,
   compatibility ranges): `just registry-validate`; add `--skip-network` for
   hermetic runs.
4. Confirm the index is fresh: `just registry-check`.
5. Run the full gate set: `just check`.

Official plugin submodules must pin a commit reachable from the plugin
repository's mainline (default branch). Never pin a feature-branch commit or an
unmerged commit; a pointer bump is a reviewed change. The policy owns the
registration checklist, the bundled-split order of operations, and the
maintenance rules.

### Local checks, SDK override, and offline tiering

`just registry-validate` keeps the official-manifest gate real instead of
silently skipping it:

- For each official entry the validator reads `plugins/<name>/bitty-plugin.toml`
  when the submodule is initialized, otherwise the workspace-relative sibling
  repository, then compares the manifest `plugin.id`, name, and license with the
  registry entry and runs the SDK's authoritative manifest lint.
- The SDK checkout is resolved in order: `BITTY_PLUGIN_SDK_DIR`, the in-repo
  `sdk/` submodule, then the workspace-relative `bitty-plugin-sdk` sibling
  (its name is derived from `.gitmodules`, never hardcoded). No host path is
  baked into the tooling.
- When no local checkout resolves for an official entry, the skipped entries
  are reported as one aggregate warning with the count, so an unverified entry
  is visible in CI rather than passing as an unchecked green.

Repository existence checks are tiered: `404`/`410` are hard errors, other HTTP
responses warn, and a network error skips only the entries that had not been
checked yet while reporting the skipped count. `--skip-network` (or
`REGISTRY_SKIP_NETWORK=1`) prints how many repository checks it skipped.

## Registry model

Registry entries are deliberately minimal. A source file declares only
hand-maintained identity data:

```toml
id = "bitty-featured.activity"
name = "Bitty Activity"
repository = "https://github.com/bitty-terminal/activity"
kind = "plugin" # optional; default "plugin"; future: theme|skill|harness|mcp|integration
author = "bitty-terminal" # optional
description = "Privacy-first local activity timeline plugin." # optional
tags = ["activity", "privacy"] # optional
categories = ["productivity"] # optional
license = "MIT" # optional

# Optional integrity fields (advisory in this phase; unsigned entries warn but
# are accepted). `manifest_hash` is the canonical-form manifest digest (H-B);
# `signature` is a detached publisher signature over the manifest and hash.
# manifest_hash = "sha256:<64 lowercase hex chars>"
# [signature]
# algorithm = "ed25519" # or "minisign", "openpgp"
# value = "<base64 or ASCII-armored detached signature>"
# signer = "bitty-terminal" # optional key id or identity

[compatibility]
bitty = ">=0.5,<1.0" # optional application range
sdk = "^0.1" # optional plugin API range (manifest `compat.plugin-api`)
```

- Derived metadata (version, stars, dates, download counts) is **never**
  duplicated in registry files. `scripts/sync-metadata.ts` reads each plugin
  repository's `bitty-plugin.toml` when it can and records the result under the
  optional `metadata` object of `generated/registry.json`; offline runs degrade
  gracefully and leave the index unchanged. Before recording anything, sync
  binds the fetched manifest to the entry: `plugin.id` must equal the entry
  `id` or the entry is reported as an error and keeps its previous metadata.
  Fetches are capped at 256 KiB (a `Content-Length` pre-check plus a streaming
  cap); an oversized body is a warning and also keeps the previous metadata.
- Integrity fields are optional in this phase. A declared `manifest_hash` or
  `signature` is shape-checked, and an unsigned entry only warns, so the format
  moves toward verification without blocking publication. `generate-index.ts`
  records a per-entry `signature_status` (`verified` | `unverified` |
  `unsigned`); no entry can be `verified` until a key-configured verification
  phase lands, so the current output is `unsigned`.
- Official `manifest_hash` values (Phase 1, H-A: raw-bytes digest) pin the
  owning repository's `bitty-plugin.toml` bytes at the submodule revision
  recorded by `git ls-tree HEAD plugins/<name>`. This is a SHA-256 digest over
  the fetched transport bytes (H-A), not semantic canonical hashing (H-B).
  Future phases will distinguish H-A from H-B via explicit version tagging.
  When an official pin moves (submodule bump or upstream manifest change),
  re-pin the hash in the same reviewed change: read the manifest bytes at the
  new pin (for example
  `git -C <checkout> show <pin>:bitty-plugin.toml | sha256sum`), write
  `manifest_hash = "sha256:<hex>"` into `registry/official/<name>.toml`, then
  run `just registry-generate` and `just registry-validate` before committing
  the entry plus the regenerated `generated/registry.json` together.
- `registry/schema.json` is the JSON Schema for entries and allows future
  kinds without a schema break.
- The generated index is sorted by `id`, generated deterministically, and
  idempotent: `generated_at` only changes when the plugin payload changes.
- `license` is an SPDX expression validated fail-closed. A license identifier
  must be in the bundled common list or use a `LicenseRef-<name>` custom
  reference, and an exception after `WITH` must be one of the bundled common
  exceptions (`Classpath-exception-2.0`, `GCC-exception-3.1`,
  `LLVM-exception`); any other identifier is a hard error that blocks index
  generation, so an unverified license never reaches the artifact. Extend the
  bundled lists in a reviewed change when a new license or exception is
  accepted.
- `tags` and `categories` are lowercase slugs deduplicated case-insensitively.
  Reusing one `repository` URL under two different `id`s is reported as a
  warning so mirrors and forks stay distinguishable.

### Version range validation

Registry `[compatibility]` ranges are validated by the structural parser in
`scripts/semver.ts` (`isValidVersionRange`), the single semver source for
registry tooling. The accepted grammar is documented once by
`VERSION_RANGE_SYNTAX` in that file and reused verbatim in diagnostics, so the
grammar cannot be restated inconsistently. The parser rejects malformed
comparator shapes (for example `>>>`), empty `,` branches, wildcard `*`,
`||` disjunction, ranges over the 128-byte budget shared with the host
resolver, hyphen ranges, and build metadata. Nonsense therefore fails at
validation instead of reaching the generated index.

#### Empirical grammar comparison (CTX-0016)

The registry grammar was compared against the accepted closed resolver grammar
(`bitty` `crates/bitty-package/src/requirement.rs`, package-followup RFC
§Constraint grammar; probed from a scratch build, no `bitty` change) and the
SDK mock host (`bitty-plugin-sdk` `src/version-range.ts`). The registry column
shows the tightened grammar; before CTX-0016 the registry differed only for
`*`, `||`, and overlong ranges, which it accepted:

| Range            | Registry | Host resolver                       | SDK mock host     |
| ---------------- | -------- | ----------------------------------- | ----------------- |
| `>=0.5,<1.0`     | accept   | reject (partial comparator version) | accept            |
| `^0.1`           | accept   | accept (`>=0.1.0 <0.2.0`)           | accept (`<1.0.0`) |
| `~1.2.3`         | accept   | accept (`>=1.2.3 <1.3.0`)           | accept            |
| `*`              | reject   | reject                              | reject            |
| `^0.1 \|\| ^0.2` | reject   | reject                              | reject            |
| `1.2.3`          | accept   | accept (`=1.2.3`)                   | accept            |
| `>=2.30`         | accept   | reject (partial comparator version) | accept            |
| `1.2.3+build`    | reject   | accept                              | reject            |
| `0.1`            | accept   | reject (partial comparator version) | accept            |

Observed divergences: the resolver rejects the partial-version shorthand
(`>=0.5`, `>=2.30`, `0.1`) that the registry and the SDK mock host accept and
that every existing entry and manifest uses; the registry rejects build
metadata the resolver accepts; and caret semantics differ for zero-major
versions (resolver `^0.1` resolves to `<0.2.0`, SDK mock host `^0.1` matches
up to `<1.0.0`).

#### Decision and pending alignment (DEC-0008)

Implemented fail-closed tightening: wildcard `*`, `||` disjunction, and ranges
over 128 bytes are rejected, because the resolver and the SDK mock host both
reject them and no entry, manifest, or fixture uses them. Build metadata stays
rejected; that is stricter than the resolver and already fail-closed.

Deferred: rejecting partial comparator versions. A hard rejection would fail
all five official entries (`bitty = ">=0.5,<1.0"` or `">=0.1,<1.0"`) and the
five plugin manifests plus the template and bundled runtime fixture, all of
which the SDK mock host accepts. Instead, validation emits a warning naming
the range when the closed resolver grammar cannot parse it — the warning
predicate mirrors the resolver parser and its budgets (64-byte version, u32
components, 16 comparators) and is regression-tested against the recorded
probe table; the range stays accepted and the entry stays publishable. Full
convergence is the pending CTX-0016 decision, with two candidate directions:
extend the resolver's comparator grammar to accept the partial-version
shorthand, or rewrite every entry, manifest, and fixture to strict `X.Y.Z`
bounds. The caret zero-major/same-major divergence is a semantic contract
question owned by the resolver and SDK, not a registry syntax change.

### Compatibility naming map

Registry entries and plugin manifests name the same two compatibility ranges
differently:

| Registry `[compatibility]` | Manifest `[compat]` | Meaning                 |
| -------------------------- | ------------------- | ----------------------- |
| `bitty`                    | `bitty`             | Bitty application range |
| `sdk`                      | `plugin-api`        | Plugin API / SDK range  |

`COMPATIBILITY_MANIFEST_FIELDS` in `scripts/registry-lib.ts` is the single
in-repo record of this mapping. A registry entry must use the registry keys, so
the manifest-side name `plugin-api` is rejected as an unsupported
`compatibility` key. The registry performs no cross-repository fetch, so drift
between a registry `sdk` range and its manifest `plugin-api` counterpart is
surfaced by reviewing both against this table when either side changes, not by
a runtime comparison.

### Dependency model

The manifest and registry layers carry dependencies differently, and that
asymmetry is deliberate (CarryCtx `DEC-0007`, `DEC-0009`).

**Plugin manifests** (`bitty-plugin.toml`) declare plugin dependencies in an
optional `[dependencies]` table that maps a plugin ID to a version range, for
example `"xuepoo.gitcore" = ">=2.0"`. This is part of the accepted manifest
schema in the [Plugin Platform
RFC](https://github.com/bitty-terminal/bitty-plugins-docs/blob/main/specifications/plugin-platform-rfc.md)
(accepted 2026-08-27): the table is hard-limited to 8 entries, and the SDK
manifest tooling bounds it (invalid identifiers, self-dependencies, and
malformed version ranges are rejected). Graph resolution — cycles, constraint
intersection, one version per ID — is the accepted resolver contract in the
[package follow-up
RFC](https://github.com/bitty-terminal/bitty-plugins-docs/blob/main/specifications/package-followup-rfc.md);
it is not implemented in this repository.

**Registry entries** (`registry/**/*.toml`) **must not** declare dependencies.
The registry is a discovery index: it has no `dependencies` field, no version
intersection, no cycle detection, and no index representation, so an installer
could not resolve a dependency declared there. `validate-registry` reports an
explicit `dependencies is not supported in registry entries` error for an entry
that declares the table, instead of a generic unknown-key error, and points the
author at the manifest `[dependencies]` table. The registry-side rejection is
therefore not a manifest-side ban: manifest validators accept and validate the
table, and the accepted signed package index mirrors manifest dependency edges.

Two accepted-corpus items stay open and fail closed in this repository:

- The closed resolver constraint grammar requires strict `X.Y.Z` comparators,
  while the registry grammar accepts the partial comparator versions that every
  current entry and manifest uses; see "Version range validation" and CarryCtx
  `DEC-0008` (CTX-0016).
- The prerelease opt-in flag (`prerelease = true` in a manifest dependency
  entry, package follow-up RFC "Prerelease policy") has no accepted TOML
  syntax: the accepted manifest schema shows the string form only, and current
  validators reject table-form dependency entries. Only the defined form is
  accepted until the owning corpus specifies the flag syntax.

Introducing a registry dependency field requires a separately authorized and
reviewed change in this repository; the manifest side is already defined by the
accepted corpus.

### Source-of-truth pipeline

```text
registry/**/*.toml
        |  scripts/validate-registry.ts   (schema, duplicates, URLs, submodule mapping, pin reachability, licenses, ranges)
        v
scripts/generate-index.ts                (deterministic merge)
        |
        v
generated/registry.json  ----------------> app/ store frontend
        |  schema_version, generated_at, plugins[]
        |                                  future `bitty plugin search/add` CLI
        v
scripts/sync-metadata.ts  (optional, bounded network refresh of manifest metadata)
```

Both the store frontend and any future CLI consume **only**
`generated/registry.json`; neither reads `registry/**` directly.

### Store frontend

`app/` is a Vite + TypeScript single-page app built from small custom
elements (`<plugin-card>`, `<plugin-search>`, `<plugin-filters>`,
`<plugin-detail>`, `<install-command>`), with no UI framework. It fetches
`/registry.json`, which `app/vite.config.ts` serves during development and
emits beside `index.html` at build time, so the deployed site reads the
committed artifact as a static asset and no second copy lives under `app/`.

The store treats the index as untrusted. It re-validates every entry's `id`
and `repository` against the registry patterns at load time, allows only
`https:` external links, and produces no install command for an illegal `id`
or repository. One-click copy is gated only by those client-side format
checks. Signature integrity fields (`manifest_hash`, `signature`) and the
index-provided `signature_status` are advisory in this phase: the client does
not verify them, so they appear as a badge with a grey-out for the unverified
state and are not claimed as tamper protection.

Client-side routes (`/`, `/plugins/<id>`, `/categories/<c>`, `/authors/<a>`,
`/sdk`, `/create-plugin`) use the History API. `app/public/_redirects`
declares the Cloudflare Pages SPA fallback (`/* /index.html 200`), which
Cloudflare applies only when no static asset matches the request. Per-route
HTML generation was not chosen: the registry is fetched at runtime, so
prerendering would duplicate rendering logic and add build complexity without
a concrete need today.

### Install CLI status

`bitty plugin add <id>` is a design proposal for the future package CLI. The
command shown in the store frontend is illustrative; the Bitty core does not
implement registry installs yet.

## Local development

All JavaScript tooling runs through `bun` / `bunx --bun`; `npm`, `npx`, and
`yarn` are never used in this repository. All gates run through the justfile:

```text
just check              # fmt-check + lint + type-check + test + registry + app-build
just fmt                # format files with Prettier (writes)
just lint               # Markdown lint (markdownlint-cli2)
just type-check         # TypeScript, scripts/ and app/
just test               # registry/tooling test suite (bun test)
just registry-validate  # validate registry entries (submodule mapping always; rest network-guarded)
just registry-generate  # rebuild generated/registry.json
just registry-sync      # refresh metadata from bitty-plugin.toml (network, optional)
just app-build          # build the static store into app/dist (Vite)
just app-dev            # run the Vite dev server for the store
just app-preview        # build and preview the store locally
just hooks-install      # install lefthook Git hooks (opt-in per checkout)
```

Use `--skip-network` with `just registry-validate --skip-network` (or
`REGISTRY_SKIP_NETWORK=1`) for hermetic runs; the validator reports how many
repository existence checks were skipped and continues with the static checks
(submodule mapping and manifest consistency still run). Without the flag, a
network error skips only the entries it had not checked yet and reports the
count; `404`/`410` remain hard errors.

## Submodules

Clone with submodules when you need the SDK, template, official plugin
sources, or the canonical docs:

```sh
git clone --recurse-submodules https://github.com/bitty-terminal/bitty-plugins.git
# or, in an existing checkout:
git submodule update --init --recursive
```

- `plugins/` contains official plugins only. Community entries are data, not
  code, and never become submodules. Every `registry/official/<name>.toml`
  entry must have a matching `plugins/<name>` submodule whose URL equals the
  entry `repository` field; `just registry-validate` enforces this offline and
  reports `plugins/<name>` directories with no official entry. Each pin must
  be a commit reachable from the plugin's default branch: the validator
  resolves the tip with `git ls-remote` and proves ancestry through the
  GitHub compare API, failing when a pin is off-mainline and degrading with a
  notice when offline. Bump a pin with `git submodule update --remote
plugins/<name>` (or an explicit SHA), then `git add plugins/<name>` and
  commit the pointer change.
- `docs/` mounts the canonical
  [bitty-plugins-docs](https://github.com/bitty-terminal/bitty-plugins-docs)
  corpus, pinned by commit. Bump it with `git submodule update --remote docs`,
  then `git add docs` and commit the pointer change. It is documentation, not
  a plugin: registry and integration tooling ignore it.

## Continuous integration

| Workflow                 | Purpose                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `registry-check.yml`     | Validates registry changes and fails when `generated/registry.json` is stale.               |
| `plugin-integration.yml` | Full quality gates plus an SDK/template/official-plugin integration smoke.                  |
| `deploy.yml`             | Builds `app/` and deploys it to Cloudflare Pages on pushes to `main` and manual dispatches. |
| `codeql.yml`             | CodeQL analysis for JavaScript/TypeScript and GitHub Actions.                               |

`deploy.yml` targets the `bitty-plugins` Cloudflare Pages project for
`plugins.bitty.run`. It reads `CLOUDFLARE_API_TOKEN` from the repository
secret of the same name (organization-variable fallback) and
`CLOUDFLARE_ACCOUNT_ID` from the organization variable. The domain was
registered on 2026-09-14 and verification may still be pending, so the
workflow builds the store but skips the deploy step with a clear notice until
the Pages project and domain are provisioned; it never deploys with partial
credentials and never stores credentials in the repository.

## Contributing and security

- Community plugin registry entries: see [CONTRIBUTING.md](CONTRIBUTING.md).
- Official plugin additions or pointer bumps: see [AGENTS.md](AGENTS.md).
- Vulnerability reporting: see [SECURITY.md](SECURITY.md).
- Agent and contributor rules: [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
