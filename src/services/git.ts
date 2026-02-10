import { spawnSync } from 'child_process';
import { isDryRun, dryRunLog } from '../utils/dry-run.js';
import { isValidBranchName } from '../utils/branch.js';
import type { WorktreeEntry } from '../types.js';

/**
 * Execute a git command safely with array arguments
 */
function gitSpawn(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf-8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0]} failed`);
  }
  return result.stdout;
}

/**
 * Get current branch name
 */
export function currentBranch(): string {
  return gitSpawn(['branch', '--show-current']).trim();
}

/**
 * Check if a branch exists locally
 */
export function branchExists(name: string): boolean {
  if (!isValidBranchName(name)) {
    return false;
  }
  try {
    gitSpawn(['rev-parse', '--verify', name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create and checkout a new branch
 */
export function checkoutNewBranch(name: string): void {
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  if (isDryRun()) {
    dryRunLog('git', `Would create and checkout new branch: ${name}`);
    return;
  }
  gitSpawn(['checkout', '-b', name]);
}

/**
 * Pull the current branch from origin
 */
export function pull(): void {
  if (isDryRun()) {
    dryRunLog('git', 'Would pull from origin');
    return;
  }
  gitSpawn(['pull']);
}

/**
 * Checkout an existing branch
 */
export function checkout(name: string): void {
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  if (isDryRun()) {
    dryRunLog('git', `Would checkout branch: ${name}`);
    return;
  }
  gitSpawn(['checkout', name]);
}

/**
 * Delete a local branch
 */
export function deleteBranch(name: string): void {
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  if (isDryRun()) {
    dryRunLog('git', `Would delete branch: ${name}`);
    return;
  }
  gitSpawn(['branch', '-D', name]);
}

/**
 * Get diff stat against a base branch
 */
export function diffStat(base = 'main'): string {
  try {
    return gitSpawn(['diff', base, '--stat']).trim();
  } catch {
    return gitSpawn(['diff', '--stat']).trim();
  }
}

/**
 * Get full diff against a base branch
 */
export function diff(base = 'main'): string {
  try {
    return gitSpawn(['diff', base]).trim();
  } catch {
    return gitSpawn(['diff']).trim();
  }
}

/**
 * Get commit messages since branching from base
 */
export function commitMessages(base = 'main'): string {
  try {
    return gitSpawn(['log', `${base}..HEAD`, '--oneline']).trim();
  } catch {
    return gitSpawn(['log', '--oneline', '-10']).trim();
  }
}

/**
 * Check if there are uncommitted changes
 */
export function hasUncommittedChanges(): boolean {
  const status = gitSpawn(['status', '--porcelain']).trim();
  return status.length > 0;
}

/**
 * Get the root directory of the git repo
 */
export function repoRoot(): string {
  return gitSpawn(['rev-parse', '--show-toplevel']).trim();
}

/**
 * Check if we're in a git repository
 */
export function isGitRepo(): boolean {
  try {
    gitSpawn(['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if current branch is a base branch (main, master, or configured base)
 */
export function isBaseBranch(): boolean {
  const current = currentBranch();
  return current === getDefaultBaseBranch();
}

/**
 * Get the name of the default base branch (main or master)
 */
export function getDefaultBaseBranch(): string {
  // Check if main exists
  if (branchExists('main')) {
    return 'main';
  }
  // Fall back to master
  if (branchExists('master')) {
    return 'master';
  }
  return 'main';
}

/**
 * Get the number of commits ahead of base branch
 */
export function commitCount(base?: string): number {
  const baseBranch = base || getDefaultBaseBranch();
  try {
    const output = gitSpawn(['rev-list', '--count', `${baseBranch}..HEAD`]).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get the number of files changed compared to base branch
 */
export function changedFilesCount(base?: string): number {
  const baseBranch = base || getDefaultBaseBranch();
  try {
    const output = gitSpawn(['diff', '--name-only', baseBranch]).trim();
    if (!output) return 0;
    return output.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Check if the current branch has a remote tracking branch
 */
export function hasRemoteTracking(): boolean {
  try {
    gitSpawn(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get commits that would be pushed (not yet on remote)
 */
export function unpushedCommitCount(): number {
  try {
    const output = gitSpawn(['rev-list', '--count', '@{u}..HEAD']).trim();
    return parseInt(output, 10) || 0;
  } catch {
    // No upstream, so all commits since base would be pushed
    return commitCount();
  }
}

/**
 * Create a linked worktree with a new branch from the base branch
 */
export function worktreeAdd(worktreePath: string, branch: string): void {
  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  if (isDryRun()) {
    dryRunLog('git', `Would create worktree at ${worktreePath} with branch ${branch}`);
    return;
  }
  const baseBranch = getDefaultBaseBranch();
  try {
    gitSpawn(['worktree', 'add', worktreePath, '-b', branch, baseBranch]);
  } catch {
    // Branch may already exist — try adding worktree with existing branch
    gitSpawn(['worktree', 'add', worktreePath, branch]);
  }
}

/**
 * Check if a worktree has uncommitted changes
 */
export function worktreeHasChanges(worktreePath: string): boolean {
  try {
    const result = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf-8' });
    return (result.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Remove a linked worktree. Uses --force to handle unclean state.
 */
export function worktreeRemove(worktreePath: string): void {
  if (isDryRun()) {
    dryRunLog('git', `Would remove worktree at ${worktreePath}`);
    return;
  }
  gitSpawn(['worktree', 'remove', worktreePath, '--force']);
}

/**
 * List all worktrees, parsed from porcelain output
 */
export function worktreeList(): WorktreeEntry[] {
  const output = gitSpawn(['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      // branch refs/heads/foo → foo
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.branch = null;
    } else if (line === '' && current.path) {
      entries.push({
        path: current.path,
        head: current.head || '',
        branch: current.branch ?? null,
        bare: current.bare || false,
      });
      current = {};
    }
  }

  // Handle last entry if no trailing blank line
  if (current.path) {
    entries.push({
      path: current.path,
      head: current.head || '',
      branch: current.branch ?? null,
      bare: current.bare || false,
    });
  }

  return entries;
}

/**
 * Detect if cwd is inside a linked (non-main) worktree
 */
export function isWorktree(): boolean {
  try {
    const entries = worktreeList();
    if (entries.length < 2) return false;
    const cwd = repoRoot();
    const main = entries[0].path;
    return cwd !== main;
  } catch {
    return false;
  }
}

/**
 * Get path to the main (primary) worktree
 */
export function mainWorktreePath(): string {
  const entries = worktreeList();
  if (entries.length === 0) {
    throw new Error('No worktrees found');
  }
  return entries[0].path;
}
