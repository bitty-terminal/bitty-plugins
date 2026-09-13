# Documentation rules

1. Write repository documentation and user-facing store text in English.
2. Registry schema, kind vocabulary, compatibility policy, and manifest
   contracts belong to `bitty-plugins-docs` / `bitty-docs`; do not invent or
   duplicate normative specifications in this repository.
3. Preserve accepted, candidate, normative, unimplemented, and compatibility
   status in README, store, and generated-index descriptions. The
   `bitty plugin add` flow is a proposal until the CLI ships.
4. Registry or storefront changes update affected canonical documentation
   before task closure; record `bitty-plugins-docs` work as a linked follow-up
   when it cannot land in the same change.
5. Cross-repository pull requests link each other and state merge ordering,
   schema revisions, compatibility windows, and migration behavior.
6. README and AGENTS guidance must remain portable; do not add links to local
   or machine-specific filesystem paths.
7. Never claim a store deployment, CLI command, plugin install, or integration
   exists without current evidence.
