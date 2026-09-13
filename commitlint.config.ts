export default {
  extends: ["@commitlint/config-conventional"],
  // CarryCtx's prepare-commit-msg hook prefixes subjects with the owning task,
  // for example "[CTX-0001] feat(registry): ..."; accept and ignore that prefix.
  parserPreset: {
    parserOpts: {
      headerPattern: /^(?:\[CTX-\d+\]\s+)?(\w*)(?:\((.*)\))?!?: (.*)$/,
      headerCorrespondence: ["type", "scope", "subject"],
    },
  },
};
