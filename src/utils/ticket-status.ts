import type { ClickUpClient } from '../services/clickup.js';
import type { ClickUpTask } from '../types.js';

export const START_PATTERNS: RegExp[] = [
  /in.?progress/i,
  /in.?dev/i,
  /doing/i,
  /active/i,
];

export const PR_PATTERNS: RegExp[] = [
  /in.?review/i,
  /code.?review/i,
  /review/i,
];

export const MERGE_REQUEST_PATTERNS: RegExp[] = [
  /awaiting.?merge/i,
  /ready.?to.?merge/i,
  /merging/i,
];

export const MERGE_PATTERNS: RegExp[] = [
  /closed/i,
  /done/i,
  /complete/i,
  /resolved/i,
];

/**
 * Resolve the target status string for a ticket transition.
 *
 * 1. If configStatus is set, return it directly.
 * 2. Otherwise, fetch the list's valid statuses and fuzzy-match against fallbackPatterns.
 * 3. Return the first match, or null if none found.
 */
export async function resolveStatus(
  clickup: ClickUpClient,
  task: ClickUpTask,
  configStatus: string | undefined,
  fallbackPatterns: RegExp[],
): Promise<string | null> {
  if (configStatus) {
    return configStatus;
  }

  if (!task.list?.id) {
    return null;
  }

  const statuses = await clickup.getListStatuses(task.list.id);

  for (const pattern of fallbackPatterns) {
    const match = statuses.find(s => pattern.test(s));
    if (match) {
      return match;
    }
  }

  return null;
}
