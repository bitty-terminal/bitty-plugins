# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Complete the official registry for the 0.0.26 host: add
  `bitty-featured.devtools` with a pinned `plugins/devtools` submodule and
  minimum-only compat `>=0.0.21`, and restore `bitty-terminal.statusline` so
  the package stays discoverable. The statusline manifest declares
  `>=0.1,<1.0`, so the entry is listed but **not installable on 0.0.26**; the
  host rejects the range and fails closed instead of activating a partial
  package.

- Official `manifest_hash` values for all five registry entries (Phase 1,
  advisory). Each entry records `sha256:<hex>` of the owning repository's
  `bitty-plugin.toml` at the pinned submodule revision, so the index binds each
  official id to exact manifest bytes while signatures and verification stay
  out of scope. The store surfaces the index-provided `signature_status` as an
  advisory badge on cards and detail pages; no verification UI is added.
  Refresh procedure: re-pin the hash with `just registry-generate` whenever an
  official pin moves (see README "Registry model").

- Registry `[compatibility]` range validation is backed by the structural
  parser in `scripts/semver.ts` as the single semver source. The accepted
  grammar is documented once by `VERSION_RANGE_SYNTAX` and reused verbatim in
  diagnostics, and `versionRangeProblem` reports the structural reason; tests
  assert those reasons for malformed comparator shapes (`>>>`), empty
  `,`/`||` branches, and leading/trailing `||`. `COMPATIBILITY_MANIFEST_FIELDS`
  records the registry `sdk` ↔ manifest `compat.plugin-api` naming map so the
  two ranges can be reviewed together.

- Optional `manifest_hash` and `signature` (`algorithm`, `value`, `signer`)
  fields in `registry/schema.json`. They are shape-checked when present and an
  unsigned entry only warns, so integrity data can be introduced without
  blocking publication. `generated/registry.json` now records a per-entry
  `signature_status` (`verified` | `unverified` | `unsigned`).

- `scripts/sync-metadata.ts` binds fetched metadata to the registry entry:
  `plugin.id` must equal the entry `id`, or the entry is reported as an error
  and keeps its previous metadata. Fetches are limited to 256 KiB through a
  `Content-Length` pre-check and a streaming cap; an oversized body warns and
  keeps the previous metadata.

- Repository initialization: official plugin directory layout, registry schema,
  validation/generation/metadata tooling, static store scaffold, pinned
  submodules for the SDK, template, and the official `activity` plugin, and
  baseline governance (AGENTS, CONTRIBUTING, SECURITY, CarryCtx, CI).

- `deploy.yml` builds the store with Bun and publishes it to the
  `bitty-plugins` Cloudflare Pages project (`plugins.bitty.run`) on pushes to
  `main` and manual dispatches; it skips with a clear notice until Cloudflare
  credentials and the Pages project exist. Production URLs are recorded:
  <https://bitty.run> (product website) and <https://plugins.bitty.run>
  (store); the domain was registered on 2026-09-14 and verification may still
  be pending.

- `BITTY_PLUGIN_SDK_DIR` overrides the SDK checkout used by `registry-validate`
  for the authoritative manifest lint; when unset the in-repo `sdk/` submodule
  and then the workspace-relative `bitty-plugin-sdk` sibling are tried, and an
  official entry whose local manifest cannot be resolved is reported as a
  counted warning instead of silently skipped.

### Changed

- Official plugin pins move to minimum-only host compatibility (bitty#2462):
  all 11 `plugins/<name>` gitlinks now point at their repositories' merged
  compat-minimum `main` commits, each `registry/official/<name>.toml` records
  the new `manifest_hash` and a `compatibility.bitty` floor with no upper
  bound (for example `>=0.0.24`), and `generated/registry.json` is
  regenerated. `scripts/semver.ts` gains `minimumOnlyRangeProblem`, and
  `registry-validate`/`registry-generate` now fail on any reintroduced ceiling
  in `compatibility.bitty` (`<`, `<=`, `=`, caret, tilde, or an exact
  version); the `sdk` range keeps its own upper bound.

- Repository metadata baseline: [CONTRIBUTING.md](CONTRIBUTING.md) documents the
  delivery lifecycle and the contributor-branch convention
  (`ctx-XXXX/<type>-<slug>`; external contributors use
  `<handle>/<type>-<slug>`), [SECURITY.md](SECURITY.md) follows the canonical
  reporting structure, `.gitattributes` normalizes text files to LF, and the
  `carryctx` devDependency is bumped to 0.11.5 with a regenerated `bun.lock`.

- `[compatibility]` range validation now rejects wildcard `*`, `||`
  disjunction, and ranges over 128 bytes — the classes the host resolver and
  the SDK mock host both reject — and emits a warning naming the range for
  accepted ranges the closed `bitty-package` comparator grammar cannot parse
  (partial comparator versions such as `>=0.5,<1.0`). Warnings do not fail
  validation, so the existing official entries and manifests stay publishable
  while the alignment decision is pending. See the README "Version range
  validation" section and CarryCtx `DEC-0008` (CTX-0016).

- A registry entry that declares a `dependencies` table now fails validation
  with an explicit "not supported in registry entries" error instead of a
  generic unknown-key error. Registry dependencies remain unsupported in this
  phase (no version intersection, cycle detection, or index field); plugin
  dependencies stay in the plugin manifest `bitty-plugin.toml` `[dependencies]`
  table, which the accepted Plugin Platform RFC defines and the SDK manifest
  tooling bounds. The manifest side is deliberately not rejected: CarryCtx
  `DEC-0009` records the registry↔manifest asymmetry with accepted-corpus
  evidence (CTX-0015). See the README "Dependency model" section.

- The store frontend now re-validates entry `id` and `repository` formats at
  load time, restricts external links to `https:`, and produces no install
  command or copy control for an illegal `id` or repository. One-click copy is
  gated only by those client-side format checks. Signature integrity fields and
  the index-provided `signature_status` are advisory in this phase (not
  client-verified) and appear only as a badge/grey-out.

- `registry-validate` repository existence checks are tiered: a network error
  skips only the entries that had not been checked yet and reports the skipped
  count, `404`/`410` stay hard errors, and `--skip-network` prints how many
  entries it skipped.

- `registry-validate` reports a duplicate `repository` URL used by different
  `id`s as a warning, deduplicates `tags`/`categories` case-insensitively, and
  treats an unknown SPDX license or `WITH` exception identifier as a hard error
  instead of a warning, so an unverified license can no longer reach the
  generated index. `LicenseRef-<name>` remains the escape hatch for custom
  terms, and the common exceptions `Classpath-exception-2.0`,
  `GCC-exception-3.1`, and `LLVM-exception` are accepted after `WITH`.

- `app/` is now a Vite + TypeScript project rendering the registry through
  small custom elements, replacing the custom Bun build. The Vite build emits
  `generated/registry.json` beside `index.html` as a static asset; the
  committed index remains the single source of truth.

- The repository remains pre-implementation and has no initial release;
  entries appear here as scoped work is accepted.

### Removed

- `bitty-terminal.statusline` removed from the official registry and the
  `plugins/` known-good set on 2026-10-22. The repository is archived and
  rejects pushes with `403`, so the prepared compat fix
  (`cmd/hygiene-0026`) cannot land and the pin cannot be maintained. The
  registry entry and the `plugins/statusline` submodule pin are deleted,
  [`generated/registry.json`](generated/registry.json) is regenerated with 11
  entries, and re-adding the plugin is tracked in
  [#110](https://github.com/bitty-terminal/bitty-plugins/issues/110).

- `bitty-terminal.wheel` removed from the official registry and the
  `plugins/` known-good set on owner decision (2026-10-19). The repository is
  the Agent Harness, not a scroll plugin, so it is not a valid official
  extension. The registry entry and the `plugins/wheel` submodule pin are
  deleted, [`generated/registry.json`](generated/registry.json) is
  regenerated, and the [wheel repository](https://github.com/bitty-terminal/wheel)
  remains available but is not an official plugin.

### Fixed

- Correct official entry drift against the current plugin mainlines: composer
  `compatibility.sdk` now mirrors the manifest `compat.plugin-api` `^1.0`
  instead of the stale `^0.1`, and file-manager's description now matches its
  current read-only cwd-scoped listing behavior instead of the former
  root-parameterized 8 KiB payload wording. History and search descriptions
  were aligned with their manifest summaries. Every official submodule pin and
  `manifest_hash` was refreshed to the current mainline.

- `integration-smoke` installs per-plugin dependencies before running each
  plugin's `check` gate: when a `plugins/*/` checkout has a justfile and a
  `bun.lock` but no `node_modules`, the recipe runs the plugin's own `install`
  target, falling back to a frozen lockfile install for plugins whose justfile
  predates the `install` target. This keeps the smoke run green for plugins
  whose gates fail closed without installed dependencies, mirroring the
  existing conditional SDK install.
