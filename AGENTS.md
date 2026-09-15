# bitty-plugins agent guide

## Repository scope and authority

- This independent repository owns the official plugin directory, the
  machine-readable registry, the generated index, and the static store
  frontend for the Bitty ecosystem. It is **not** a monorepo of community
  plugins and does not own plugin implementations.
- The canonical remote is
  <https://github.com/bitty-terminal/bitty-plugins>.
- Production surfaces (owner-provided, 2026-09-14): <https://bitty.run> is the
  product website owned by [`bitty-website`](https://github.com/bitty-terminal/bitty-website) (Astro), and
  <https://plugins.bitty.run> is this repository's plugin store. The domain was
  newly registered; Cloudflare verification may still be pending.
- Organization-level Cloudflare variables `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_API_TOKEN` exist for CI/CD. The `bitty-plugins` Pages project and
  the `plugins.bitty.run` custom domain are provisioned outside this
  repository. Never commit credentials.
- Canonical plugin architecture, manifest, security, packaging, and
  compatibility contracts belong to [`bitty-plugins-docs`](https://github.com/bitty-terminal/bitty-plugins-docs), mounted here at
  `docs/` as a Git submodule pinned to a commit. [`bitty-docs`](https://github.com/bitty-terminal/bitty-docs) owns shared
  governance (decisions, security corpus, reviews, project state). This
  repository must not invent manifest fields, capability semantics, or release
  policy.
- The project is pre-implementation. Registry tooling and the static store
  prototype exist; the `bitty plugin add <id>` CLI flow is a design proposal,
  not implemented behavior. Never describe the store or CLI as shipped.
- Product behavior changes require an explicitly scoped task.

## Read before acting

1. Read this guide and the active task's files under `.carryctx/rules/`.
2. Inspect the CarryCtx task, team context, dependencies, and exact scopes.
3. Verify the relevant contracts in the `docs/` submodule (bitty-plugins-docs)
   and `bitty-docs` before changing registry semantics or storefront claims;
   run `git submodule update --init` when `docs/` is empty.
4. Read narrowly (targeted sections first) and use `rg` for discovery.

## CarryCtx and delivery

- CarryCtx is the durable execution record; the external harness runs agents.
- Every agent binds a named session to the task, records progress, decisions,
  risks, and checkpoints, and stays inside explicit scopes.
- The normal lifecycle is GitHub Issue, CarryCtx task/team/dependencies/scopes,
  isolated worktree and branch, commit, pull request, independent review plus
  CI, merge, documentation synchronization, checkpoint, task completion, and
  Issue closure.
- After the first commit, parallel work uses a dedicated branch and worktree.
  Branches use `ctx-XXXX/<type>-<short-slug>` (`XXXX` is the owning CarryCtx
  task number; `<type>` is one of `feat|fix|chore|docs`; slug is short
  kebab-case) with worktrees at `.worktrees/ctx-XXXX-<type>-<short-slug>`;
  one branch per task, commander housekeeping may use `cmd/<slug>`.
- Before the first commit, initialization may use the shared checkout only with
  disjoint scopes and CI-equivalent local checks.
- Implementers stop at review. Independent review by a different agent plus
  required CI is the acceptance gate; green CI is not a substitute for review.
- Do not commit, push, merge, publish, release, or mutate remote state unless
  the task or user explicitly authorizes it.

## Registry contracts

- `registry/**/*.toml` is the source of truth; `generated/registry.json` is a
  generated artifact. Never hand-edit `generated/registry.json`; run
  `just registry-generate`.
- Official plugins are pinned submodules under `plugins/`; updating one means
  bumping the submodule pointer in a reviewed change. The pointer must pin a
  commit reachable from the plugin repository's mainline (default branch);
  never pin a feature-branch or unmerged commit. The canonical onboarding,
  compatibility, and maintenance rules live in `bitty-plugins-docs`
  `product/official-plugin-onboarding.md`, mounted at `docs/`.
- `sdk/`, `template/`, and `docs/` are submodules too, but they are not
  plugins: `docs/` mounts the canonical `bitty-plugins-docs` corpus (initialize
  with `git submodule update --init`; bump with `git submodule update --remote
docs` plus `git add docs`) and is excluded from registry and
  plugin-integration discovery.
- Community plugins are **never** submodules. They exist only as
  `registry/community/<author>-<slug>.toml` entries.
- Entries stay minimal: `id`, `name`, `repository`, optional `kind` (default
  `"plugin"`), `author`, `description`, `tags`, `categories`, `license`, and
  optional `[compatibility] bitty` / `sdk` ranges. Never add derived metadata
  (version, stars, dates, downloads); `scripts/sync-metadata.ts` populates the
  optional `metadata` object from each plugin's `bitty-plugin.toml`.
- Downstream consumers (store, future CLI) read only
  `generated/registry.json`. Do not add a second read path.

## Storefront rules

- `app/` is a static site built with Vite + TypeScript and small custom
  elements (vanilla DOM / Web Components). Do not add a UI framework, a
  server, or a runtime dependency beyond `generated/registry.json`.
- The Vite build emits `generated/registry.json` beside `index.html` as the
  `/registry.json` static asset; do not commit a second copy under `app/`.
- Client-side routes use the History API and rely on the Cloudflare Pages SPA
  fallback in `app/public/_redirects`; keep deep links working.
- Registry data is untrusted input. Render it with DOM text nodes or
  `textContent`; never interpolate registry values into `innerHTML`.
- Keep the store lightweight and accessible: semantic landmarks, labeled
  controls, visible focus, keyboard-operable links, adequate contrast, and
  `prefers-color-scheme` support.
- Install commands shown in the store are proposals; label them as such.
- `deploy.yml` builds `app/` with Bun and publishes it to the `bitty-plugins`
  Cloudflare Pages project (`plugins.bitty.run`) on pushes to `main` and
  manual dispatches. Credentials resolve only from CI configuration
  (`CLOUDFLARE_API_TOKEN`: repository secret with organization-variable
  fallback; `CLOUDFLARE_ACCOUNT_ID`: organization variable). Never commit
  tokens, never add a second publish path, and keep the workflow skipping the
  deploy with a clear notice while provisioning is incomplete.

## Toolchain policy

- JavaScript runs on `bun` (pinned version in the justfile).
- Run quality gates via the repository justfile: `just check`, plus
  `just fmt`, `just lint`, `just type-check`, `just test`,
  `just registry-validate`, `just registry-generate`, `just app-build`.
- Version pins live in exactly one place per pin: the justfile for bunx tool
  pins, `package.json` + `bun.lock` for installed dev dependencies. Do not bump
  pins as a side effect of an unrelated task; report drift instead.
- CI success is a hard acceptance gate. Workflow-affecting changes are
  validated locally with `actionlint` and an `act -n` dry run before push.

## No hardcoded values

- Never hardcode host- or environment-specific values: absolute paths,
  usernames, hostnames, credentials, ports, or machine layout.
- Derive values from configuration, environment variables, or repository
  metadata. Repository names and URLs come from the registry entries, the git
  remote, or parameters, never from literals duplicated across scripts.
- Tests, fixtures, docs, and scripts obey the same rule; durable artifacts must
  not embed a developer's checkout path.
- Use named constants for policy-bounded values (timeouts, limits, defaults).

## Security and supply chain

- Registry TOML files, manifests fetched over the network, and plugin metadata
  are untrusted data. Validate before use; never execute registry content.
- Network access from scripts is bounded: explicit timeouts, no secrets, no
  credentials, and graceful offline degradation.
- Submodule pointers are reviewed changes. Community entries never gain code
  execution or clone authority through this repository.
- No secrets, tokens, or local configuration in the repository, fixtures, logs,
  or CI output. Fork pull requests run read-only with no secrets.

## Verification and handoff

- Keep edits inside the active CarryCtx scope and preserve unrelated work.
- Run `just check` plus `actionlint`, `act -n` on affected workflows, and
  `gitleaks detect --source .` before concluding a change.
- Documentation synchronization is part of definition of done: update this
  repository's README/CHANGELOG and, for canonical material, the
  `bitty-plugins-docs` corpus by bumping the `docs/` submodule pointer
  (`git submodule update --remote docs`, then `git add docs`).
- Report changed files, exact evidence, residual risks, and required
  cross-repository updates. A passing local check does not prove deployment,
  registry trust, or product implementation.

## Workspace conventions

- Run Git and CarryCtx inside this repository, never from the umbrella root.
- Use this repository's `recording/` (gitignored) area for durable scratch material; ephemeral
  scratch belongs under `/tmp/bitty/`. Never write scratch outside those locations and
  never into unrelated workspace paths.
