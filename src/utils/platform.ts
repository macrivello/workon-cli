import type { ClickUpCustomField, Config, RepoConfig, MergeStrategy } from '../types.js';

/**
 * Extract the Platform value from a task's custom fields.
 * The Platform field is a dropdown where `value` is the orderindex into the options array.
 */
export function getPlatform(customFields?: ClickUpCustomField[]): string | null {
  if (!customFields) return null;

  const platformField = customFields.find(f => f.name.toLowerCase() === 'platform');
  if (!platformField?.type_config?.options || platformField.value == null) return null;

  const idx = typeof platformField.value === 'number'
    ? platformField.value
    : parseInt(String(platformField.value), 10);

  if (isNaN(idx)) return null;

  const option = platformField.type_config.options[idx];
  return option?.name || null;
}

/**
 * Resolve a platform name to a RepoConfig using the config repos mapping.
 * Tries exact match first, then case-insensitive, then substring.
 */
export function resolveRepo(platform: string, repos: Record<string, RepoConfig>): RepoConfig | null {
  // Exact match
  if (repos[platform]) return repos[platform];

  // Case-insensitive match
  const lower = platform.toLowerCase();
  for (const [key, config] of Object.entries(repos)) {
    if (key.toLowerCase() === lower) return config;
  }

  // Substring match
  for (const [key, config] of Object.entries(repos)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return config;
    }
  }

  return null;
}

/**
 * Resolve just the repo path for a platform.
 */
export function resolveRepoPath(platform: string, repos: Record<string, RepoConfig>): string | null {
  return resolveRepo(platform, repos)?.path ?? null;
}

/**
 * Given a task's custom fields and config, resolve the repo path.
 */
export function getRepoForTask(customFields: ClickUpCustomField[] | undefined, config: Config): string | null {
  const platform = getPlatform(customFields);
  if (!platform || !config.repos) return null;
  return resolveRepoPath(platform, config.repos);
}

/**
 * Get the merge strategy for the current working directory.
 * Matches cwd against repo paths in config.
 */
export function getMergeStrategy(config: Config): MergeStrategy {
  if (!config.repos) return 'mergebot';

  const cwd = process.cwd();
  for (const repoConfig of Object.values(config.repos)) {
    if (cwd.startsWith(repoConfig.path)) {
      return repoConfig.merge ?? 'mergebot';
    }
  }

  return 'mergebot';
}
