import type { ClickUpTask, HierarchyTree, Config } from '../types.js';
import type { ClickUpClient } from '../services/clickup.js';
import { getPlatform } from './platform.js';

/**
 * Given a task (already fetched), resolve the full parent/subtask tree.
 * - If task.parent exists: fetch parent, then all siblings as full tasks.
 * - If no parent: fetch subtasks. If any exist, fetch each as full task.
 * - If standalone (no parent, no subtasks): return null.
 */
export async function fetchHierarchyTree(
  clickup: ClickUpClient,
  task: ClickUpTask,
): Promise<HierarchyTree | null> {
  if (task.parent) {
    // Task is a subtask — fetch parent and all siblings
    const parent = await clickup.getTask(task.parent);
    const subtaskStubs = await clickup.getTaskSubtasks(task.parent);
    const subtasks = await clickup.getTasksFull(subtaskStubs.map(s => s.id));
    return { parent, subtasks };
  }

  // Task might be a parent — check for subtasks
  const subtaskStubs = await clickup.getTaskSubtasks(task.id);
  if (subtaskStubs.length === 0) return null;

  const subtasks = await clickup.getTasksFull(subtaskStubs.map(s => s.id));
  return { parent: task, subtasks };
}

/**
 * Build structured text for AI prompts from a hierarchy tree.
 * Truncates descriptions to keep token counts manageable.
 */
export function buildHierarchyContext(tree: HierarchyTree, config?: Config): string {
  const parentDesc = (tree.parent.text_content || tree.parent.description || '').trim();
  const parentPlatform = getPlatform(tree.parent.custom_fields);

  const lines: string[] = [
    `# Parent: ${tree.parent.name} [${tree.parent.id}]`,
    parentPlatform ? `Platform: ${parentPlatform}` : '',
    '',
    '## Description',
    truncate(parentDesc, 3000),
    '',
    '---',
  ].filter(l => l !== undefined);

  for (let i = 0; i < tree.subtasks.length; i++) {
    const sub = tree.subtasks[i];
    const subDesc = (sub.text_content || sub.description || '').trim();
    const subPlatform = getPlatform(sub.custom_fields);

    lines.push('');
    lines.push(`# Subtask ${i + 1}: ${sub.name} [${sub.id}]${subPlatform ? ` [${subPlatform}]` : ''}`);
    lines.push('## Description');
    lines.push(truncate(subDesc, 2000));
  }

  return lines.join('\n');
}

/**
 * Heuristic ordering of subtasks by platform dependency.
 * Returns tiers: each tier is an array of subtask IDs that can run in parallel.
 * Tiers are sequential (tier 1 before tier 2).
 * Backend/API tasks → tier 1, client tasks → tier 2, unknown → tier 3.
 */
export function inferDependencyOrder(tree: HierarchyTree, config?: Config): string[][] {
  const priorityMap: Record<string, number> = {
    backend: 1, api: 1, rails: 1, server: 1,
    client: 2, android: 2, ios: 2, web: 2, mobile: 2, frontend: 2,
  };

  const scored = tree.subtasks.map(sub => {
    const platform = (getPlatform(sub.custom_fields) || sub.name).toLowerCase();
    let priority = 3; // default: unknown platform
    for (const [key, score] of Object.entries(priorityMap)) {
      if (platform.includes(key)) {
        priority = Math.min(priority, score);
      }
    }
    return { id: sub.id, priority };
  });

  // Group by priority tier
  const tiers = new Map<number, string[]>();
  for (const { id, priority } of scored) {
    const tier = tiers.get(priority) ?? [];
    tier.push(id);
    tiers.set(priority, tier);
  }

  // Return tiers in priority order
  return [...tiers.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ids]) => ids);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n[...truncated]';
}
