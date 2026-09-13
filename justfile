# Bitty Plugins quality gates.
#
# Tool version pins live here (one place); installed dev dependencies are
# pinned in package.json + bun.lock. All JavaScript tooling runs through
# bun / bunx; never use npm, npx, or yarn, and never invoke formatters or
# linters directly by name.

markdownlint_pin := "0.23.1"
prettier_pin := "3.9.6"
commitlint_pin := "21.2.2"
lefthook_pin := "2.1.10"
wrangler_pin := "4.125.0"

# List available recipes.
default:
	@just --list

# Lint all Markdown sources against .markdownlint-cli2.jsonc.
lint:
	bunx --bun markdownlint-cli2@{{markdownlint_pin}}

# Lint specific Markdown files (used by the pre-commit hook).
lint-files *files:
	bunx --bun markdownlint-cli2@{{markdownlint_pin}} {{files}}

# Format all recognized files with Prettier.
fmt:
	bunx --bun prettier@{{prettier_pin}} --write . --ignore-unknown

# Check formatting of all recognized files with Prettier.
fmt-check:
	bunx --bun prettier@{{prettier_pin}} --check . --ignore-unknown

# Check formatting of specific files (used by the pre-commit hook).
fmt-check-files *files:
	bunx --bun prettier@{{prettier_pin}} --check {{files}}

# Type-check scripts/ and app/ with the TypeScript pinned in package.json.
type-check:
	bunx --bun tsc -p tsconfig.json --noEmit
	cd app && bunx --bun tsc -p tsconfig.json --noEmit

# Run this repository's registry and tooling test suite (tests/ only;
# submodule suites run through integration-smoke).
test:
	bun test

# Validate registry entries: schema, duplicate ids, repository URL format and
# existence (bounded, skipped with a notice when offline), license expressions,
# and compatibility range syntax. Non-zero exit on any error.
registry-validate *args:
	bun scripts/validate-registry.ts {{args}}

# Rebuild generated/registry.json deterministically from registry/**/*.toml.
registry-generate:
	bun scripts/generate-index.ts

# Fail when generated/registry.json is stale relative to registry/**/*.toml.
registry-check:
	bun scripts/generate-index.ts --check

# Refresh optional manifest metadata into generated/registry.json from each
# plugin's bitty-plugin.toml. Bounded, credential-free network access; degrades
# gracefully when offline.
registry-sync *args:
	bun scripts/sync-metadata.ts {{args}}

# Build the static store frontend into app/dist.
app-build:
	cd app && bun run build

# Validate a commit message file with commitlint (conventional commits).
commit-check message=".git/COMMIT_EDITMSG":
	test -d node_modules/@commitlint/config-conventional || bun install --frozen-lockfile
	bunx --bun commitlint@{{commitlint_pin}} --edit "{{message}}"

# Install Git hooks managed by lefthook (opt-in per contributor checkout).
hooks-install:
	bunx --bun lefthook@{{lefthook_pin}} install

# Remove lefthook-managed Git hooks.
hooks-uninstall:
	bunx --bun lefthook@{{lefthook_pin}} uninstall

# Lint GitHub Actions workflows with the locally installed actionlint.
# CI runs the same version as rhysd/actionlint:1.7.12 in a container.
actionlint:
	actionlint -color

# Cross-submodule integration smoke: SDK, template, and official plugin
# repositories. Requires initialized submodules; uninitialized ones are
# reported and skipped. The Bitty core host is not available yet, so this
# covers repository-level gates only.
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
			just --justfile "$dir/justfile" check || status=1
		else
			echo "== integration: $dir is not initialized; skipping (git submodule update --init --recursive)"
		fi
	done
	shopt -s nullglob
	for dir in plugins/*/; do
		if [[ -f "${dir}justfile" ]]; then
			echo "== integration: ${dir%/}"
			just --justfile "${dir}justfile" check || status=1
		else
			echo "== integration: ${dir%/} has no justfile; skipping"
		fi
	done
	echo "== integration: Bitty core host is not yet available; repository-level gates only."
	exit "$status"

# Aggregate read-only gate run locally and in CI.
check: fmt-check lint type-check test registry-validate registry-check app-build

# Deploy the built store to Cloudflare Pages. Requires CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID and a provisioned Pages project; dormant until then.
deploy *args:
	cd app && bunx --bun wrangler@{{wrangler_pin}} pages deploy dist --project-name bitty-plugins --branch main {{args}}
