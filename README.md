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

[compatibility]
bitty = ">=0.5,<1.0" # optional application range
sdk = "^0.1" # optional SDK range
```

- Derived metadata (version, stars, dates, download counts) is **never**
  duplicated in registry files. `scripts/sync-metadata.ts` reads each plugin
  repository's `bitty-plugin.toml` when it can and records the result under the
  optional `metadata` object of `generated/registry.json`; offline runs degrade
  gracefully and leave the index unchanged.
- `registry/schema.json` is the JSON Schema for entries and allows future
  kinds without a schema break.
- The generated index is sorted by `id`, generated deterministically, and
  idempotent: `generated_at` only changes when the plugin payload changes.

### Source-of-truth pipeline

```text
registry/**/*.toml
        |  scripts/validate-registry.ts   (schema, duplicates, URLs, licenses, ranges)
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
just registry-validate  # validate registry entries (network-guarded)
just registry-generate  # rebuild generated/registry.json
just registry-sync      # refresh metadata from bitty-plugin.toml (network, optional)
just app-build          # build the static store into app/dist (Vite)
just app-dev            # run the Vite dev server for the store
just app-preview        # build and preview the store locally
just hooks-install      # install lefthook Git hooks (opt-in per checkout)
```

Use `--skip-network` with `just registry-validate --skip-network` (or
`REGISTRY_SKIP_NETWORK=1`) for hermetic runs; with no network the validator
prints a notice and continues with static checks only.

## Submodules

Clone with submodules when you need the SDK, template, official plugin
sources, or the canonical docs:

```sh
git clone --recurse-submodules https://github.com/bitty-terminal/bitty-plugins.git
# or, in an existing checkout:
git submodule update --init --recursive
```

- `plugins/` contains official plugins only. Community entries are data, not
  code, and never become submodules.
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
