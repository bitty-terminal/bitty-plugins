# Security rules

1. Treat registry entries, plugin manifests, fetched metadata, and referenced
   repositories as untrusted input. Validate before use and never execute
   registry content.
2. Keep the storefront injection-safe: render registry values as text nodes or
   attributes, never into `innerHTML`, `eval`, or URL schemes beyond `https`.
3. Bound network access from scripts: explicit timeouts, a total fetch budget,
   no credentials, no secrets, and graceful offline degradation.
4. Validate repository URLs (HTTPS only, no credentials/query/fragment) and
   compatibility ranges before they reach generated artifacts.
5. Community entries grant no clone, install, or execution authority. Official
   plugins enter only as reviewed, pinned submodule pointers.
6. Never commit secrets, tokens, local databases, or machine-local
   configuration; fork pull requests run read-only with no secrets.
7. Pin dependencies, Actions, and submodules; review supply-chain changes.
8. A changed trust boundary requires documented risks, negative tests, and
   independent security review before merge.
