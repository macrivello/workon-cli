import { spawnSync } from 'child_process';
import type { GitHubPr, GitHubPrStatus, GitHubReview, GitHubReviewComment } from '../types.js';
import { isDryRun, dryRunLog } from '../utils/dry-run.js';

/**
 * Execute a gh CLI command safely with array arguments and return parsed JSON
 */
function ghSpawn<T>(args: string[]): T {
  const result = spawnSync('gh', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `gh ${args[0]} failed`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Execute a gh CLI command safely with array arguments without parsing
 */
function ghSpawnRaw(args: string[]): string {
  const result = spawnSync('gh', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `gh ${args[0]} failed`);
  }
  return result.stdout.trim();
}

/**
 * Check if gh CLI is available and authenticated
 */
export function isGhAvailable(): boolean {
  try {
    const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Get PR for the current branch
 */
export function getPrForCurrentBranch(): GitHubPr | null {
  try {
    return ghSpawn<GitHubPr>(['pr', 'view', '--json', 'number,title,url,state,body']);
  } catch {
    return null;
  }
}

/**
 * Get PR by number
 */
export function getPr(prNumber: number): GitHubPr {
  return ghSpawn<GitHubPr>(['pr', 'view', String(prNumber), '--json', 'number,title,url,state,body']);
}

/**
 * Get detailed PR status including CI and reviews
 */
export function getPrStatus(prNumber: number): GitHubPrStatus {
  const data = ghSpawn<{
    reviewDecision: string | null;
    reviews: Array<{ author: { login: string }; state: string }>;
    statusCheckRollup: Array<{
      name: string;
      status: string;
      conclusion: string | null;
    }> | null;
  }>(['pr', 'view', String(prNumber), '--json', 'reviewDecision,reviews,statusCheckRollup']);

  return {
    reviewDecision: data.reviewDecision,
    reviews: (data.reviews || []).map(r => ({
      author: r.author.login,
      state: r.state,
    })),
    checks: (data.statusCheckRollup || []).map(c => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
    })),
  };
}

/**
 * Create a new PR
 */
export function createPr(options: {
  title: string;
  body: string;
  draft?: boolean;
  base?: string;
}): GitHubPr {
  if (isDryRun()) {
    dryRunLog('github', 'Would create PR', {
      title: options.title,
      body: options.body,
      draft: options.draft,
      base: options.base,
    });
    return { number: 0, title: options.title, url: 'https://github.com/example/repo/pull/0 (dry-run)', state: 'open' };
  }

  const args = ['pr', 'create', '--title', options.title, '--body', options.body];

  if (options.draft) args.push('--draft');
  if (options.base) args.push('--base', options.base);

  const url = ghSpawnRaw(args);

  // Extract PR number from URL
  const match = url.match(/\/pull\/(\d+)/);
  const number = match ? parseInt(match[1], 10) : 0;

  return { number, title: options.title, url, state: 'open' };
}

/**
 * Comment on a PR
 */
export function commentOnPr(prNumber: number, body: string): void {
  if (isDryRun()) {
    dryRunLog('github', `Would comment on PR #${prNumber}`, { body });
    return;
  }
  ghSpawnRaw(['pr', 'comment', String(prNumber), '--body', body]);
}

/**
 * Get PR body content
 */
export function getPrBody(prNumber: number): string {
  const pr = ghSpawn<{ body: string }>(['pr', 'view', String(prNumber), '--json', 'body']);
  return pr.body || '';
}

/**
 * Update a PR's title and/or body
 */
export function updatePr(
  prNumber: number,
  options: { title?: string; body?: string }
): void {
  if (isDryRun()) {
    dryRunLog('github', `Would update PR #${prNumber}`, {
      title: options.title,
      body: options.body,
    });
    return;
  }

  const args = ['pr', 'edit', String(prNumber)];

  if (options.title) {
    args.push('--title', options.title);
  }

  if (options.body) {
    args.push('--body', options.body);
  }

  ghSpawnRaw(args);
}

/**
 * Get the full "owner/repo" name for the current repository
 */
export function getRepoFullName(): string {
  const data = ghSpawn<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner']);
  return data.nameWithOwner;
}

/**
 * Get top-level reviews for a PR
 */
export function getPrReviews(prNumber: number): GitHubReview[] {
  const data = ghSpawn<{
    reviews: Array<{
      author: { login: string };
      state: string;
      body: string;
      submittedAt: string;
    }>;
  }>(['pr', 'view', String(prNumber), '--json', 'reviews']);

  return (data.reviews || [])
    .filter(r => r.state !== 'PENDING' && r.body.trim() !== '')
    .map(r => ({
      author: r.author.login,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt,
    }));
}

/**
 * Get inline review comments for a PR
 */
export function getPrReviewComments(prNumber: number): GitHubReviewComment[] {
  const repoFullName = getRepoFullName();
  const data = ghSpawn<Array<{
    id: number;
    user: { login: string };
    body: string;
    path: string;
    line: number | null;
    original_line: number | null;
    created_at: string;
    in_reply_to_id?: number;
  }>>(['api', `repos/${repoFullName}/pulls/${prNumber}/comments`]);

  return (data || []).map(c => ({
    id: c.id,
    author: c.user.login,
    body: c.body,
    path: c.path,
    line: c.line ?? c.original_line,
    createdAt: c.created_at,
    inReplyToId: c.in_reply_to_id ?? null,
  }));
}

/**
 * Get the merge state of a PR: OPEN, CLOSED, or MERGED
 */
export function getPrState(prNumber: number): string {
  const data = ghSpawn<{ state: string }>(['pr', 'view', String(prNumber), '--json', 'state']);
  return data.state;
}

/**
 * Merge a PR directly via gh CLI
 */
export function mergePr(prNumber: number, strategy: 'squash' | 'merge'): void {
  if (isDryRun()) {
    dryRunLog('github', `Would merge PR #${prNumber} with --${strategy}`);
    return;
  }
  ghSpawnRaw(['pr', 'merge', String(prNumber), `--${strategy}`, '--delete-branch']);
}

/**
 * Check if a PR is in draft state
 */
export function isPrDraft(prNumber: number): boolean {
  const data = ghSpawn<{ isDraft: boolean }>(['pr', 'view', String(prNumber), '--json', 'isDraft']);
  return data.isDraft;
}

/**
 * Mark a draft PR as ready for review
 */
export function markPrReady(prNumber: number): void {
  if (isDryRun()) {
    dryRunLog('github', `Would mark PR #${prNumber} as ready for review`);
    return;
  }
  ghSpawnRaw(['pr', 'ready', String(prNumber)]);
}

/**
 * Reply to an inline review comment on a PR
 */
export function replyToReviewComment(prNumber: number, commentId: number, body: string): void {
  if (isDryRun()) {
    dryRunLog('github', `Would reply to comment #${commentId} on PR #${prNumber}`, { body });
    return;
  }
  const repoFullName = getRepoFullName();
  ghSpawn(['api', `repos/${repoFullName}/pulls/${prNumber}/comments/${commentId}/replies`, '-f', `body=${body}`]);
}

/**
 * Re-request reviewers on a PR
 */
export function requestReviewers(prNumber: number, reviewers: string[]): void {
  if (isDryRun()) {
    dryRunLog('github', `Would re-request review on PR #${prNumber}`, { reviewers });
    return;
  }
  ghSpawnRaw(['pr', 'edit', String(prNumber), '--add-reviewer', reviewers.join(',')]);
}

/**
 * Push current branch to origin
 */
export function pushBranch(): void {
  // Safety check: never push main or master
  const branchResult = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf-8' });
  const currentBranch = branchResult.stdout.trim();

  if (currentBranch === 'main' || currentBranch === 'master') {
    throw new Error(`Safety check: refusing to push ${currentBranch} branch`);
  }

  if (isDryRun()) {
    dryRunLog('github', 'Would push current branch to origin');
    return;
  }
  const result = spawnSync('git', ['push', '-u', 'origin', 'HEAD'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git push failed');
  }
}
