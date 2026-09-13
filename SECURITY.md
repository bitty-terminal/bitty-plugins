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
- Network access in scripts is bounded by explicit timeouts, requires no
  credentials, and degrades gracefully offline.
- Fork pull requests run with read-only permissions and no secrets.
- Dependencies, Actions, and submodules are pinned; workflow changes require
  local `actionlint` and `act -n` validation.
- No secrets, tokens, or machine-local configuration are committed.
