# Bitty Plugins quality gates.
#
# All JavaScript and TypeScript gates run natively through Bun 1.4.4 (`bun fmt`,
# `bun check`, `bun test`).

wrangler_pin := "4.125.0"

# List available recipes.
default:
	@just --list

# Format all recognized files with Bun's native formatter.
fmt:
	bun fmt --no-script --no-config --ignore-unknown --ignore-pattern="generated/**"

# Check formatting of all recognized files with Bun's native formatter.
fmt-check:
	bun fmt --no-script --no-config --check --ignore-unknown --ignore-pattern="generated/**"

# Check formatting of specific files (used by the pre-commit hook).
fmt-check-files *files:
	bun fmt --no-script --no-config --check --ignore-unknown --ignore-pattern="generated/**" {{files}}

# Type-check scripts/ and app/ with Bun's native TypeScript checker.
type-check:
	bun check --no-script -p tsconfig.json
	cd app && bun run type-check

# Run this repository's registry and tooling test suite (tests/ only;
# submodule suites run through integration-smoke).
test:
	bun test

# Validate registry entries: schema, duplicate ids, repository URL format and
# existence (bounded, skipped with a notice when offline), official entry to
# plugins/ submodule mapping and pin presence (static, always runs offline),
# submodule pin mainline reachability and manifest hash binding (bounded,
# skipped with a notice when offline), license expressions, and compatibility
# range syntax. Non-zero exit on any error.
registry-validate *args:
	bun scripts/validate-registry.ts {{args}}

# Rebuild generated/registry.json deterministically from registry/**/*.toml.
registry-generate:
	bun scripts/generate-index.ts

# Fail when generated/registry.json is stale relative to registry/**/*.toml.
registry-check:
	bun scripts/generate-index.ts --check

# Validate the signed extension catalog snapshot publisher, Ed25519 signature,
# release SHA256SUMS cross-check, and read-back verification contract (#121).
catalog-validate *args:
	bun scripts/extension-catalog.ts --self-test {{args}}

# Refresh optional manifest metadata into generated/registry.json from each
# plugin's bitty-plugin.toml. Bounded, credential-free network access; degrades
# gracefully when offline.
registry-sync *args:
	bun scripts/sync-metadata.ts {{args}}

# Build the static store frontend into app/dist (Vite).
app-build:
	cd app && bun run build

# Run the Vite dev server for the store (serves generated/registry.json).
app-dev:
	cd app && bun run dev

# Build and preview the store the way the deploy target serves it.
app-preview: app-build
	cd app && bun run preview

# Install Git hooks managed by lefthook and CarryCtx.
hooks-install:
	lefthook install pre-commit
	carryctx hooks install --compose

# Lint GitHub Actions workflows with the locally installed actionlint.
# CI runs the same version as rhysd/actionlint:1.7.12 in a container.
actionlint:
	actionlint -color

# Cross-submodule integration smoke: SDK, template, and official plugin
# repositories. Requires initialized submodules; uninitialized ones are
# reported and skipped. Per-plugin dependencies are installed on demand (the
# plugin's own `install` target when present, otherwise a frozen lockfile
# install) so fail-closed plugin gates run green. The Bitty core host is not
# available yet, so this covers repository-level gates only.
integration-smoke:
	#!/usr/bin/env bash
	set -euo pipefail
	status=0
	# Expose the SDK manifest linter to plugin test suites that support it, so
	# plugin manifests are checked against the same schema the SDK ships.
	if [[ -f sdk/src/cli.ts && ! -d sdk/node_modules ]]; then
		echo "== integration: installing sdk dependencies"
		(cd sdk && bun install --frozen-lockfile) || status=1
	fi
	if [[ -f sdk/src/cli.ts ]]; then
		export BITTY_PLUGIN_LINT="$PWD/sdk/src/cli.ts"
		echo "== integration: SDK manifest lint enabled (BITTY_PLUGIN_LINT)"
	fi
	for dir in sdk template; do
		if [[ -f "$dir/justfile" ]]; then
			echo "== integration: $dir"
			if [[ -f "$dir/bun.lock" && ! -d "$dir/node_modules" ]]; then
				echo "== integration: installing $dir dependencies"
				if just --justfile "$dir/justfile" --show install >/dev/null 2>&1; then
					just --justfile "$dir/justfile" install || status=1
				else
					(cd "$dir" && bun install --frozen-lockfile) || status=1
				fi
			fi
			just --justfile "$dir/justfile" check || status=1
		else
			echo "== integration: $dir is not initialized; skipping (git submodule update --init --recursive)"
		fi
	done
	shopt -s nullglob
	for dir in plugins/*/; do
		if [[ -f "${dir}justfile" ]]; then
			echo "== integration: ${dir%/}"
			if [[ -f "${dir}bun.lock" && ! -d "${dir}node_modules" ]]; then
				echo "== integration: installing ${dir%/} dependencies"
				if just --justfile "${dir}justfile" --show install >/dev/null 2>&1; then
					just --justfile "${dir}justfile" install || status=1
				else
					(cd "$dir" && bun install --frozen-lockfile) || status=1
				fi
			fi
			just --justfile "${dir}justfile" check || status=1
		else
			echo "== integration: ${dir%/} has no justfile; skipping"
		fi
	done
	echo "== integration: Bitty core host is not yet available; repository-level gates only."
	exit "$status"

# Aggregate read-only gate run locally and in CI.
check: fmt-check type-check test registry-validate registry-check catalog-validate app-build

# Deploy the built store to Cloudflare Pages. Requires CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID and a provisioned Pages project; dormant until then.
deploy *args:
	cd app && bunx --bun wrangler@{{wrangler_pin}} pages deploy dist --project-name bitty-plugins --branch main {{args}}

# Publish a redacted CarryCtx snapshot inside this repo (commander merge
# closeout only; never a git hook). `carryctx export --publication` redacts the
# bundle, stamps manifest.redacted, and commits one snapshot to the fixed ref
# `refs/heads/carryctx-snapshots`; the target pushes that branch only when the
# local ref advanced. Canonical closeout runs from the primary checkout on
# branch main (`cd "$BITTY_WORKSPACE/bitty-plugins" && just workflow-publish`); a
# detached or feature worktree records that branch as the snapshot source. Dry
# run validates the export and writes neither the ref nor the remote.
workflow-publish *args:
    bash scripts/workflow-publish.sh {{args}}

workflow-publish-dry *args:
    bash scripts/workflow-publish.sh --dry-run {{args}}

# Restore the local CarryCtx DB from the in-repo snapshot branch
# `refs/heads/carryctx-snapshots` (fresh-clone recipe). Refuses to replace a
# non-empty local DB without --force, e.g. `just workflow-import --force`.
workflow-import *args:
    bash scripts/workflow-import.sh {{args}}

workflow-import-dry *args:
    bash scripts/workflow-import.sh --dry-run {{args}}
