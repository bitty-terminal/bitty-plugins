/**
 * Search and filter helpers for the registry list.
 *
 * Scoring runs over untrusted display fields only. Time complexity is
 * O(n · t · f) for n plugins, t query tokens, and f inspected fields; space is
 * O(n) for the scored result set.
 */

import type { Plugin } from "./registry.ts";

export interface PluginFilterState {
  kind?: string;
  category?: string;
  scope?: "all" | "official" | "community";
}

export interface PluginQuery extends PluginFilterState {
  query?: string;
}

const FIELD_WEIGHTS = {
  id: 60,
  name: 50,
  author: 30,
  category: 25,
  tag: 25,
  description: 10,
} as const;

function scoreToken(plugin: Plugin, token: string): number {
  let score = 0;

  const id = plugin.id.toLowerCase();
  if (id === token) return 100;
  if (id.startsWith(token)) score += FIELD_WEIGHTS.id + 20;
  else if (id.includes(token)) score += FIELD_WEIGHTS.id;

  const name = plugin.name.toLowerCase();
  if (name === token) score += 100;
  else if (name.startsWith(token)) score += FIELD_WEIGHTS.name + 20;
  else if (name.includes(token)) score += FIELD_WEIGHTS.name;

  if (plugin.author?.toLowerCase().includes(token))
    score += FIELD_WEIGHTS.author;
  for (const category of plugin.categories ?? []) {
    if (category.toLowerCase().includes(token)) score += FIELD_WEIGHTS.category;
  }
  for (const tag of plugin.tags ?? []) {
    if (tag.toLowerCase().includes(token)) score += FIELD_WEIGHTS.tag;
  }
  if (plugin.description?.toLowerCase().includes(token))
    score += FIELD_WEIGHTS.description;

  return score;
}

export function searchPlugins(plugins: Plugin[], query: string): Plugin[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...plugins];

  const scored: Array<{ plugin: Plugin; score: number }> = [];
  for (const plugin of plugins) {
    let total = 0;
    let matches = true;
    for (const token of tokens) {
      const score = scoreToken(plugin, token);
      if (score === 0) {
        matches = false;
        break;
      }
      total += score;
    }
    if (matches) scored.push({ plugin, score: total });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.plugin.id.localeCompare(b.plugin.id),
  );
  return scored.map((entry) => entry.plugin);
}

export function filterPlugins(
  plugins: Plugin[],
  filters: PluginQuery,
): Plugin[] {
  const byQuery = filters.query
    ? searchPlugins(plugins, filters.query)
    : plugins;
  return byQuery.filter((plugin) => {
    if (filters.kind && plugin.kind !== filters.kind) return false;
    if (filters.category && !plugin.categories?.includes(filters.category))
      return false;
    if (filters.scope === "official" && !plugin.official) return false;
    if (filters.scope === "community" && plugin.official) return false;
    return true;
  });
}
