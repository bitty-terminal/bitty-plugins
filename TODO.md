# TODO

Tracked follow-ups for the `bitty-plugins` bootstrap. Each item is expected to
become an Issue and CarryCtx task in the owning repository before work starts.

## Repository and registry

- [ ] Record the registry contract and open questions in `bitty-plugins-docs`
      (kind vocabulary, compatibility ranges, community review policy).
- [ ] Decide whether canonical categories become a closed vocabulary or remain
      open slugs; update `registry/schema.json` and docs together.
- [ ] Richer manifest-derived metadata once `bitty-plugin-sdk` ships
      `bitty-plugin-lint`: wire `scripts/validate-registry.ts` to the SDK CLI
      and fail validation when a manifest is missing or invalid.

## Store frontend

- [ ] Provision the Cloudflare Pages project, `plugins.bitty-terminal.org`
      domain, and deployment secrets; then activate `deploy.yml`.
- [ ] Store UX follow-ups: search relevance, kind filters, pagination, and
      deep-link stability for renamed entries.
- [ ] Add storefront accessibility review evidence (keyboard, contrast,
      screen-reader pass) once content stabilizes.

## Integration

- [ ] Deeper `plugin-integration.yml` smoke once Bitty core wiring lands:
      install the pinned plugin into a real host headlessly and assert
      lifecycle behavior instead of SDK/template/plugin gates only.
- [ ] Decide the official plugin onboarding order and add the remaining
      first-party wave plugins as pinned submodules.

## Tooling

- [ ] Re-test the Dependabot `bun` ecosystem updater (removed 2026-09-14 after
      a failed trial run) and re-enable it if it becomes reliable; the
      devDependencies currently have no automated updates.

## Ecosystem

- [ ] Create the `beacon` repository (next official plugin) and register it.
- [ ] Publish the CLI proposal (`bitty plugin add/search`) in
      `bitty-plugins-docs` and link it from the store once accepted.
