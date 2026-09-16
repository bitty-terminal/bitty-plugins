# Contributing to bitty-plugins

This guide is for contributors to the `bitty-plugins` repository. The
repository is pre-implementation: the registry toolchain and the static store
prototype exist, while the `bitty plugin add <id>` CLI flow is a design
proposal, not shipped behavior.

## Repository ground rules

- Read [AGENTS.md](AGENTS.md) before making any change. It defines authority,
  scope boundaries, CarryCtx workflow, toolchain policy, and the security and
  privacy constraints that override convenience.
- Canonical plugin architecture, manifest, security, packaging, and
  compatibility contracts live in `bitty-plugins-docs` (mounted at `docs/`);
  shared governance lives in `bitty-docs`. This repository must not invent
  manifest fields, capability semantics, or release policy independently.
- Community plugin entries under `registry/community/<author>-<slug>.toml` are
  metadata only. Community plugins are never submodules and never gain install,
  execution, or clone authority; official plugins live in `plugins/` as pinned
  submodules updated through reviewed pointer bumps.
- Never commit, push, publish packages, or mutate remote state without
  explicit authorization from the owning task.

## Prerequisites

Toolchain expectations (dependency versions are pinned in
[package.json](package.json) and locked in `bun.lock`; never invoke formatters
or linters by name):

- `just` — command runner owning all quality-gate invocations.
- `bun` / `bun run <bin>` — JavaScript execution and package management; the
  justfile invokes installed tools as `bun run <bin>`. Never use `npm`, `npx`,
  or `yarn` in any Bitty repository.
- `markdownlint-cli2`, `prettier`, `commitlint`, `lefthook` — pinned in the
  justfile and run through `bunx --bun`; the committed dev dependencies are
  materialized by `bun install`.

## Development setup

1. Enter this repository before running Git, CarryCtx, or toolchain commands.
2. Install pinned development dependencies: `bun install`.
3. Enable Git hooks (optional): `just hooks-install`.
4. Run all quality gates: `just check` (Prettier format check, Markdown lint,
   type check, tests, registry validation, generated-index freshness, and the
   static store build). CI runs the same aggregate target.
5. Record scoped work in CarryCtx (task, session, progress, checkpoint) and
   stop at review; independent review is required for acceptance.

Use `just registry-validate --skip-network` for hermetic offline runs, and run
`just registry-generate` after registry edits so `generated/registry.json`
stays current.

## Delivery lifecycle

Changes follow Issue -> Branch -> Commit -> Pull Request -> Review -> Merge,
where independent review plus required CI must pass before merge. Every pull
request states its Issue and CarryCtx task links, impact areas, security and
privacy impact, reproducible gate evidence, and documentation synchronization
status. Labels (`feat`/`fix`/`docs`/`chore`, `P0`/`P1`/`P2`, `area:*`) and
milestone `v0.1.0` are kept in sync. Community pull requests from outside
contributors do not require a CarryCtx task; maintainers link them to the
owning tracking work.

## Contributor branches

Branches are managed with CarryCtx. Official branches use
`ctx-XXXX/<type>-<slug>`, where `XXXX` is the owning CarryCtx task number,
`<type>` is one of `feat|fix|chore|docs`, and the slug is short kebab-case;
commander housekeeping branches may use `cmd/<slug>`. External contributors
must use a distinguishable prefix, for example `<github-handle>/<type>-<slug>`.

## Capabilities and privacy

Manifest capability requests are deny by default and must stay minimal; this
repository indexes metadata and a registry entry never grants capability,
install, or execution authority. Registry entries, fetched manifests, and
generated artifacts are untrusted input: validate before use, never execute
registry content, and never add install scripts, secrets, or ambient authority
as a side effect of an unrelated change.

## Workflow snapshots

The engineering workflow snapshot lives in this repository on the branch
`refs/heads/carryctx-snapshots`. Merges run `just workflow-publish` (dry run:
`just workflow-publish-dry`) as part of the commander closeout; snapshots are
redacted publication artifacts and are never merged back. Fresh clones restore
with `just workflow-import` (`just workflow-import-dry`).

## Reporting

Report bugs and feature requests through the GitHub issue templates. Report
security issues privately per [SECURITY.md](SECURITY.md); never open a public
issue for a vulnerability.
