---
name: Community registry entry
about: Propose a community plugin entry for the registry
title: "registry: add "
labels: "enhancement,area:plugin"
assignees: ""
---

## Plugin name

## Plugin id and repository URL

- id: [e.g. yourhandle.your-plugin]
- repository: [https://github.com/owner/repo]
- license: [SPDX identifier]
- compatibility: [e.g. bitty = ">=0.5,<1.0", sdk = "^0.1"]

## Description

One sentence describing the plugin, free of marketing claims.

## Manifest

Confirm the repository contains a `bitty-plugin.toml` at the default branch
root, and paste its `plugin.id` and `plugin.version` values.

## Checklist

- [ ] The plugin code lives in my own repository (not vendored here)
- [ ] I understand community entries are metadata only and are never submodules
- [ ] I can open the registry pull request myself (or this issue requests it)
