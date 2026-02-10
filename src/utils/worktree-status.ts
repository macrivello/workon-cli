import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as git from '../services/git.js';
import { extractTicketIdFromBranch } from './branch.js';
import type { WorktreeStatus, WorktreeInfo, WorktreePipelineStage } from '../types.js';

const STATUS_FILENAME = '.workon-status.json';

/**
 * Write status to current worktree
 */
export function writeStatus(status: WorktreeStatus): void {
  const filePath = join(git.repoRoot(), STATUS_FILENAME);
  writeFileSync(filePath, JSON.stringify(status, null, 2) + '\n', 'utf-8');
}

/**
 * Write status to a specific worktree path
 */
export function writeStatusTo(worktreePath: string, status: WorktreeStatus): void {
  const filePath = join(worktreePath, STATUS_FILENAME);
  writeFileSync(filePath, JSON.stringify(status, null, 2) + '\n', 'utf-8');
}

/**
 * Read status from a specific worktree path
 */
export function readStatus(worktreePath: string): WorktreeStatus | null {
  const filePath = join(worktreePath, STATUS_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as WorktreeStatus;
  } catch {
    return null;
  }
}

/**
 * Aggregate statuses from all linked worktrees
 */
export function readAllStatuses(): WorktreeInfo[] {
  const entries = git.worktreeList();
  const mainPath = entries.length > 0 ? entries[0].path : null;

  return entries.map((entry) => {
    const isMain = entry.path === mainPath;
    const status = readStatus(entry.path);
    const ticketId = status?.ticketId
      ?? (entry.branch ? extractTicketIdFromBranch(entry.branch) : null);

    return {
      ...entry,
      ticketId,
      status,
      isMain,
    };
  });
}

/**
 * Create initial status for a new worktree
 */
export function createInitialStatus(ticketId: string, ticketName: string, branch: string): WorktreeStatus {
  const now = new Date().toISOString();
  return {
    ticketId,
    ticketName,
    branch,
    stage: 'starting',
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Merge partial updates into current worktree's status
 */
export function updateStatus(updates: Partial<Pick<WorktreeStatus, 'stage' | 'prUrl' | 'prNumber' | 'blockedReason' | 'completedAt'>>): void {
  const root = git.repoRoot();
  const current = readStatus(root);
  if (!current) {
    throw new Error('No .workon-status.json found in current worktree');
  }

  const updated: WorktreeStatus = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  if (updates.stage === 'completed' && !updated.completedAt) {
    updated.completedAt = new Date().toISOString();
  }

  writeStatus(updated);
}

/**
 * Get worktrees base directory: <main-worktree-root>/.worktrees/
 */
export function worktreesDir(): string {
  return join(git.mainWorktreePath(), '.worktrees');
}

/**
 * Get worktree path for a ticket: <main-worktree-root>/.worktrees/<ticket-id>/
 */
export function worktreePathForTicket(ticketId: string): string {
  return join(worktreesDir(), ticketId);
}
