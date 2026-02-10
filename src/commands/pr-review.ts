import chalk from 'chalk';
import { createSpinner } from '../utils/ui.js';
import * as git from '../services/git.js';
import * as github from '../services/github.js';
import type { GitHubReview, GitHubReviewComment } from '../types.js';

export interface PrReviewCommandOptions {
  json?: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().split('T')[0];
}

function stateColor(state: string): (text: string) => string {
  switch (state) {
    case 'APPROVED': return chalk.green;
    case 'CHANGES_REQUESTED': return chalk.red;
    default: return chalk.dim;
  }
}

function renderReviews(reviews: GitHubReview[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold('── Reviews ──────────────────────────'));
  lines.push('');

  for (const r of reviews) {
    const color = stateColor(r.state);
    lines.push(`${chalk.cyan(`@${r.author}`)} — ${color(r.state)} (${formatDate(r.submittedAt)})`);
    lines.push(`  ${r.body.trim()}`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderInlineComments(comments: GitHubReviewComment[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold('── Inline Comments ──────────────────'));
  lines.push('');

  // Separate top-level comments from replies
  const topLevel = comments.filter(c => c.inReplyToId === null);
  const repliesByParent = new Map<number, GitHubReviewComment[]>();
  for (const c of comments) {
    if (c.inReplyToId !== null) {
      const existing = repliesByParent.get(c.inReplyToId) || [];
      existing.push(c);
      repliesByParent.set(c.inReplyToId, existing);
    }
  }

  // Group top-level by file path
  const byFile = new Map<string, GitHubReviewComment[]>();
  for (const c of topLevel) {
    const existing = byFile.get(c.path) || [];
    existing.push(c);
    byFile.set(c.path, existing);
  }

  for (const [path, fileComments] of byFile) {
    for (const c of fileComments) {
      const lineStr = c.line != null ? `:${c.line}` : '';
      lines.push(`${chalk.yellow(`${path}${lineStr}`)} — ${chalk.cyan(`@${c.author}`)} (${formatDate(c.createdAt)})`);
      lines.push(`  ${c.body.trim()}`);

      // Render replies
      const replies = repliesByParent.get(c.id) || [];
      for (const reply of replies) {
        lines.push('');
        lines.push(`  ${chalk.dim('↳')} ${chalk.cyan(`@${reply.author}`)} (${formatDate(reply.createdAt)})`);
        lines.push(`    ${reply.body.trim()}`);
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderSummary(reviews: GitHubReview[], comments: GitHubReviewComment[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold('── Summary ──────────────────────────'));

  const approved = reviews.filter(r => r.state === 'APPROVED').length;
  const changesRequested = reviews.filter(r => r.state === 'CHANGES_REQUESTED').length;
  const commented = reviews.filter(r => r.state === 'COMMENTED').length;

  const parts: string[] = [];
  if (approved > 0) parts.push(`${approved} approved`);
  if (changesRequested > 0) parts.push(`${changesRequested} changes requested`);
  if (commented > 0) parts.push(`${commented} commented`);

  lines.push(`${reviews.length} review${reviews.length !== 1 ? 's' : ''}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`);

  const topLevel = comments.filter(c => c.inReplyToId === null);
  const files = new Set(topLevel.map(c => c.path));
  lines.push(`${comments.length} inline comment${comments.length !== 1 ? 's' : ''} across ${files.size} file${files.size !== 1 ? 's' : ''}`);

  return lines.join('\n');
}

export async function prReviewCommand(prNumberArg?: string, options: PrReviewCommandOptions = {}): Promise<void> {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  if (!github.isGhAvailable()) {
    console.error(chalk.red('GitHub CLI (gh) is not available.'));
    process.exit(1);
  }

  // Resolve PR number
  let prNumber: number;

  if (prNumberArg) {
    prNumber = parseInt(prNumberArg, 10);
  } else {
    const pr = github.getPrForCurrentBranch();
    if (!pr) {
      console.log(chalk.yellow('No PR found for this branch.'));
      return;
    }
    prNumber = pr.number;
  }

  const spinner = createSpinner('Fetching review feedback...').start();

  try {
    const pr = github.getPr(prNumber);
    const reviews = github.getPrReviews(prNumber);
    const comments = github.getPrReviewComments(prNumber);
    spinner.stop();

    // JSON mode
    if (options.json) {
      console.log(JSON.stringify({ reviews, comments }, null, 2));
      return;
    }

    // Empty state
    if (reviews.length === 0 && comments.length === 0) {
      console.log(chalk.dim(`No review feedback on PR #${prNumber}.`));
      return;
    }

    // Human mode
    console.log(chalk.bold(`\nPR #${pr.number}: ${pr.title}`));
    console.log(chalk.dim(pr.url));
    console.log('');

    if (reviews.length > 0) {
      console.log(renderReviews(reviews));
    }

    if (comments.length > 0) {
      console.log(renderInlineComments(comments));
    }

    console.log(renderSummary(reviews, comments));
  } catch (error) {
    spinner.fail('Failed to fetch review feedback');
    console.error(chalk.red(error));
  }
}
