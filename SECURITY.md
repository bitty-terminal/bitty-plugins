# Security Policy

## Supported Versions

This repository is pre-implementation. No version has been released, so no
version is supported yet.

| Version    | Supported |
| ---------- | --------- |
| unreleased | No        |

This table must be updated when the first release is published.

## Reporting a Vulnerability

To report a security vulnerability, open a private
[GitHub Security Advisory](https://github.com/bitty-terminal/bitty-plugins/security/advisories/new).

Do not report security vulnerabilities via public GitHub issues, discussions,
or pull requests.

## Disclosure Policy

- Reports are handled privately until a fix or mitigation is available and a
  coordinated disclosure date is agreed with the reporter.
- Please include reproduction steps, affected components or interfaces, and any
  observed impact. Keep proof-of-concept material minimal.
- We will acknowledge reports as soon as practical, typically within five
  business days, and provide a status update at least every seven business days
  until resolution.
- Credit is given to reporters in release notes unless anonymity is requested.

## Scope Notes for This Repository

This repository owns a registry and a static storefront, not plugin execution.
Findings that are in scope include, even while the project is
pre-implementation, because they shape accepted contracts:

- registry validation bypasses (duplicate `id`, spoofed `repository` URLs,
  malformed compatibility ranges, schema gaps that admit unsafe `kind` values);
- script behavior with untrusted registry or manifest input, including
  resource exhaustion, path traversal, or unexpected network activity;
- storefront cross-site scripting or data injection through registry fields;
- supply-chain concerns in pinned dependencies, GitHub Actions, and submodule
  pointers;
- secret exposure in generated artifacts, logs, or workflows.

Out of scope here: vulnerabilities in a plugin's own code, the Bitty core, or
the plugin host. Report those to their owning repository. A community registry
entry is not an endorsement of the referenced plugin's security.

## Hardening Rules Followed by This Repository

- Registry and manifest data is treated as untrusted input; scripts validate
  before use and never execute registry content.
- Registry entries optionally carry a `manifest_hash` and a `signature`
  (`algorithm`, `value`, `signer`). The shape is validated and a
  `signature_status` is recorded in `generated/registry.json`; unsigned entries
  only warn because no verification keys are configured yet. These fields are
  advisory index data: the client does not verify them, and store entries that
  are not `verified` are shown with an advisory badge/grey-out only. The copy
  action is not gated by this index-provided status.
- Manifest metadata sync binds the fetched `plugin.id` to the registry entry
  `id`: a mismatch is an error and the entry keeps its previous metadata.
  Fetches are bounded to 256 KiB with a `Content-Length` pre-check and a
  streaming cap; an oversized body warns and also keeps the previous metadata.
- The storefront re-validates entry `id` and `repository` formats at runtime,
  allows only `https:` external links, and yields no install command for an
  illegal `id` or repository. Copy is gated only by those client-side format
  checks; a tampered index cannot introduce an invalid install target or a
  non-HTTPS link, but signature fields are not a client-side tamper defense in
  this phase.
- Network access in scripts is bounded by explicit timeouts, requires no
  credentials, and degrades gracefully offline.
- Fork pull requests run with read-only permissions and no secrets.
- Dependencies, Actions, and submodules are pinned; workflow changes require
  local `actionlint` and `act -n` validation.
- No secrets, tokens, or machine-local configuration are committed.
