# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- `app/` is now a Vite + TypeScript project rendering the registry through
  small custom elements, replacing the custom Bun build. The Vite build emits
  `generated/registry.json` beside `index.html` as a static asset; the
  committed index remains the single source of truth.

- The repository remains pre-implementation and has no initial release;
  entries appear here as scoped work is accepted.
