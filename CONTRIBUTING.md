# Contributing

Thanks for considering a contribution to Bitty Plugins. This repository is the
official plugin directory, registry, and store frontend for the Bitty
ecosystem. Read [AGENTS.md](AGENTS.md) for repository authority, registry
contracts, and agent workflow rules before making changes.

## What belongs here

- **Community plugin entries** — one registry file per plugin under
  `registry/community/<author>-<slug>.toml`. This is an awesome-list model:
  the plugin code stays in your own repository; this repository stores only
  metadata.
- **Official plugin changes** — maintained by `bitty-terminal`. Official
  plugins live in `plugins/` as pinned submodules; add or update them through
  a reviewed pointer bump, not a community entry.
- **Registry tooling and storefront fixes** — see the development loop below.

Community plugins are **never** added as submodules and never granted install
or execution authority by merging an entry.

## Adding a community plugin entry

1. Fork this repository and create a branch.
2. Add `registry/community/<author>-<slug>.toml`, where `<author>` is your
   lowercase handle and `<slug>` identifies the plugin. One file per plugin.
3. Keep the entry minimal:

   ```toml
   id = "yourhandle.your-plugin"
   name = "Your Plugin"
   repository = "https://github.com/you/your-plugin"
   author = "yourhandle"
   description = "One sentence, no marketing claims."
   tags = ["utility"]
   categories = ["utility"]
   license = "MIT"

   [compatibility]
   bitty = ">=0.5"
   sdk = "^0.1"
   ```

   Do not include version numbers, stars, dates, or download counts. That
   metadata is derived from your `bitty-plugin.toml` by
   `just registry-sync` and must not be duplicated by hand.

4. Run the gates locally (requires `bun` and `just`):

   ```sh
   just registry-validate
   just registry-generate
   just check
   ```

5. Open a pull request using the repository template. CI validates the entry,
   regenerates `generated/registry.json`, and fails if the generated file is
   stale.
6. A maintainer reviews the entry, the repository URL, and the plugin's
   manifest before merge. Entries may be declined for name collisions,
   incomplete metadata, unreachable repositories, or policy conflicts.

## Development loop

All quality gates run through the repository justfile; never invoke formatters,
linters, or scripts directly by name, and never use `npm`, `npx`, or `yarn`:

```text
just check              # full read-only gate set
just fmt                # format files with Prettier (writes)
just lint               # Markdown lint
just type-check         # TypeScript (scripts/ and app/)
just test               # registry/tooling tests
just registry-validate  # validate registry entries
just registry-generate  # rebuild generated/registry.json
just app-build          # build the static store
```

Use `just registry-validate --skip-network` for hermetic offline runs. Git
hooks are wired by [lefthook.yml](lefthook.yml); install them once with
`just hooks-install`. Commits are message-linted, and staged Markdown files are
checked before each commit.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and
are validated against [commitlint.config.ts](commitlint.config.ts):

```text
feat(registry): add community entry for xuepoo-markdown
fix(app): escape tag text in plugin detail view
docs(readme): clarify official versus community boundary
chore(ci): pin actionlint in workflow checks
```

## Delivery lifecycle

Repository work follows the Bitty lifecycle: GitHub Issue, CarryCtx task with
team/dependencies/scopes, branch and isolated worktree, focused commits, pull
request with evidence, independent review plus required CI, merge,
documentation synchronization, and task closure. Community pull requests from
outside contributors do not require a CarryCtx task; maintainers link them to
the owning tracking work.

## Reporting problems

- Security issues: follow [SECURITY.md](SECURITY.md); never open a public issue
  for a vulnerability.
- Registry or storefront bugs: use the bug report template.
- Feature requests: use the feature request template.
