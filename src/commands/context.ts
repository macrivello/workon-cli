import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import * as git from '../services/git.js';
import * as github from '../services/github.js';
import { readAllStatuses } from '../utils/worktree-status.js';

export interface ContextCommandOptions {
  json?: boolean;
}

interface WorkflowContext {
  ticket: {
    id: string;
    name: string;
    status: string;
    url: string;
  } | null;
  git: {
    branch: string;
    isBaseBranch: boolean;
    hasUncommittedChanges: boolean;
    aheadOfBase: number;
  };
  pr: {
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    ciPassed: boolean;
    ciPending: number;
    ciFailed: string[];
    approvals: string[];
    changesRequested: string[];
  } | null;
  worktrees: Array<{
    ticketId: string | null;
    ticketName: string | null;
    stage: string;
    branch: string | null;
    prUrl: string | null;
    blockedReason: string | null;
    path: string;
  }>;
  recommendedAction: string;
}

export async function contextCommand(options: ContextCommandOptions = {}): Promise<void> {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  const branch = git.currentBranch();
  const isBase = git.isBaseBranch();

  const context: WorkflowContext = {
    ticket: null,
    git: {
      branch,
      isBaseBranch: isBase,
      hasUncommittedChanges: git.hasUncommittedChanges(),
      aheadOfBase: isBase ? 0 : git.commitCount(),
    },
    pr: null,
    worktrees: [],
    recommendedAction: '',
  };

  // Fetch ticket info
  const ticketId = extractTicketIdFromBranch(branch);
  if (ticketId) {
    try {
      const config = loadConfig();
      const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);
      const task = await clickup.getTask(ticketId);
      context.ticket = {
        id: task.id,
        name: task.name,
        status: task.status.status,
        url: task.url,
      };
    } catch {
      // Ticket fetch failed — continue without it
    }
  }

  // Fetch PR info
  if (!isBase && github.isGhAvailable()) {
    try {
      const pr = github.getPrForCurrentBranch();
      if (pr) {
        const status = github.getPrStatus(pr.number);
        const isDraft = github.isPrDraft(pr.number);

        const ciPassed = status.checks.every(c => c.conclusion === 'success');
        const ciPending = status.checks.filter(c => !c.conclusion).length;
        const ciFailed = status.checks.filter(c => c.conclusion === 'failure').map(c => c.name);
        const approvals = status.reviews.filter(r => r.state === 'APPROVED').map(r => r.author);
        const changesRequested = status.reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author);

        context.pr = {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          isDraft,
          ciPassed,
          ciPending,
          ciFailed,
          approvals,
          changesRequested,
        };
      }
    } catch {
      // PR fetch failed — continue without it
    }
  }

  // Gather worktree data
  try {
    const allInfo = readAllStatuses();
    context.worktrees = allInfo.filter(w => !w.isMain).map(w => ({
      ticketId: w.ticketId,
      ticketName: w.status?.ticketName || null,
      stage: w.status?.stage || 'unknown',
      branch: w.branch,
      prUrl: w.status?.prUrl || null,
      blockedReason: w.status?.blockedReason || null,
      path: w.path,
    }));
  } catch {
    // Not in a worktree-capable repo — continue without
  }

  // Determine recommended action
  context.recommendedAction = determineNextAction(context);

  if (options.json) {
    console.log(JSON.stringify(context, null, 2));
    return;
  }

  // Human-readable output
  renderContext(context);
}

function determineNextAction(ctx: WorkflowContext): string {
  // Check for blocked worktrees regardless of current branch state
  const blockedWorktrees = ctx.worktrees.filter(w => w.stage === 'blocked');
  const blockedSuffix = blockedWorktrees.length > 0
    ? ` (${blockedWorktrees.length} background worktree${blockedWorktrees.length > 1 ? 's' : ''} blocked — run \`workon worktree list\`)`
    : '';

  if (ctx.git.isBaseBranch) {
    return 'Pick a task: run `workon tasks` or `workon next`' + blockedSuffix;
  }

  // Check if the PR was already merged — branch needs cleanup
  if (ctx.pr && ctx.pr.state === 'MERGED') {
    return 'Branch merged — run `workon cleanup`';
  }

  if (ctx.git.hasUncommittedChanges) {
    return 'Commit your changes';
  }

  if (!ctx.pr) {
    if (ctx.git.aheadOfBase > 0) {
      return 'Create a PR: run `workon pr`';
    }
    return 'Write code — no commits yet';
  }

  if (ctx.pr.isDraft) {
    return 'Mark PR as ready: run `workon pr-ready`';
  }

  if (ctx.pr.ciFailed.length > 0) {
    return 'Fix CI failures: run `workon ci-failure`';
  }

  if (ctx.pr.ciPending > 0) {
    return 'Wait for CI to complete';
  }

  if (ctx.pr.changesRequested.length > 0) {
    return 'Address review feedback: run `workon pr-review`';
  }

  if (ctx.pr.approvals.length === 0) {
    return 'Wait for review approval';
  }

  if (ctx.pr.ciPassed && ctx.pr.approvals.length > 0) {
    return 'Ready to merge: run `workon merge`';
  }

  return 'Check PR status: run `workon pr-status`' + blockedSuffix;
}

function renderContext(ctx: WorkflowContext): void {
  console.log(chalk.bold('\n--- Workflow Context ---\n'));

  // Git
  console.log(chalk.bold('Git'));
  console.log(`  Branch: ${chalk.cyan(ctx.git.branch)}`);
  if (ctx.git.hasUncommittedChanges) {
    console.log(`  ${chalk.yellow('Uncommitted changes')}`);
  }
  if (!ctx.git.isBaseBranch && ctx.git.aheadOfBase > 0) {
    console.log(`  ${ctx.git.aheadOfBase} commit${ctx.git.aheadOfBase !== 1 ? 's' : ''} ahead of base`);
  }

  // Ticket
  if (ctx.ticket) {
    console.log('');
    console.log(chalk.bold('Ticket'));
    console.log(`  ${ctx.ticket.name}`);
    console.log(`  Status: ${chalk.dim(ctx.ticket.status)}`);
    console.log(`  ${chalk.blue(ctx.ticket.url)}`);
  }

  // PR
  if (ctx.pr) {
    console.log('');
    console.log(chalk.bold('PR'));
    console.log(`  #${ctx.pr.number}: ${ctx.pr.title}${ctx.pr.isDraft ? chalk.dim(' (draft)') : ''}`);

    // CI
    if (ctx.pr.ciPassed && ctx.pr.ciPending === 0) {
      console.log(`  ${chalk.green('CI: All checks passed')}`);
    } else {
      if (ctx.pr.ciFailed.length > 0) {
        console.log(`  ${chalk.red(`CI: ${ctx.pr.ciFailed.length} failed`)}`);
      }
      if (ctx.pr.ciPending > 0) {
        console.log(`  ${chalk.yellow(`CI: ${ctx.pr.ciPending} pending`)}`);
      }
    }

    // Reviews
    if (ctx.pr.approvals.length > 0) {
      console.log(`  ${chalk.green(`Approved by ${ctx.pr.approvals.join(', ')}`)}`);
    }
    if (ctx.pr.changesRequested.length > 0) {
      console.log(`  ${chalk.red(`Changes requested by ${ctx.pr.changesRequested.join(', ')}`)}`);
    }
    if (ctx.pr.approvals.length === 0 && ctx.pr.changesRequested.length === 0) {
      console.log(`  ${chalk.yellow('Awaiting review')}`);
    }

    console.log(`  ${chalk.blue(ctx.pr.url)}`);
  }

  // Background worktrees
  if (ctx.worktrees.length > 0) {
    console.log('');
    console.log(chalk.bold('Background Work'));
    for (const wt of ctx.worktrees) {
      const id = wt.ticketId || 'unknown';
      const stageColor = wt.stage === 'blocked' ? chalk.red
        : wt.stage === 'completed' ? chalk.green
        : wt.stage === 'ready-to-merge' ? chalk.green
        : chalk.cyan;
      const stage = stageColor(`[${wt.stage}]`);
      const name = wt.ticketName || '';
      const pr = wt.prUrl ? `  | ${chalk.blue(wt.prUrl)}` : '';
      const blocked = wt.blockedReason ? `  ${chalk.red(wt.blockedReason)}` : '';
      console.log(`  ${id}  ${stage}  ${name}${pr}${blocked}`);
    }
  }

  // Next action
  console.log('');
  console.log(chalk.bold('Next'));
  console.log(`  ${chalk.green(ctx.recommendedAction)}`);
  console.log('');
}
