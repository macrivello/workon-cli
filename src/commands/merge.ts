import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { createSpinner, showSuccess, showWarning } from '../utils/ui.js';
import * as git from '../services/git.js';
import * as github from '../services/github.js';
import { prStatusCommand } from './pr-status.js';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import { resolveStatus, MERGE_PATTERNS, MERGE_REQUEST_PATTERNS } from '../utils/ticket-status.js';
import { getMergeStrategy } from '../utils/platform.js';
import { cleanupCommand } from './cleanup.js';
import type { MergeStrategy } from '../types.js';

export async function mergeCommand(prNumberArg?: string, options: { yes?: boolean } = {}): Promise<void> {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  const config = loadConfig();
  const strategy = getMergeStrategy(config);

  // Get status first
  const status = await prStatusCommand(prNumberArg);

  if (!status) {
    return;
  }

  console.log('');

  const strategyLabel = strategy === 'mergebot' ? 'Post /merge comment' : `Merge via gh pr merge --${strategy}`;

  if (status.isReady) {
    const shouldMerge = options.yes || await confirm({
      message: `${strategyLabel}?`,
      default: true,
    });

    if (shouldMerge) {
      await executeMerge(status.prNumber, strategy);
      await updateTicketOnMerge(status.prNumber, strategy);
    }
  } else {
    showWarning('PR is not ready to merge.');

    const forceAnyway = !options.yes && await confirm({
      message: chalk.yellow(`${strategyLabel} anyway? (not recommended)`),
      default: false,
    });

    if (forceAnyway) {
      await executeMerge(status.prNumber, strategy);
      await updateTicketOnMerge(status.prNumber, strategy);
    }
  }
}

async function executeMerge(prNumber: number, strategy: MergeStrategy): Promise<void> {
  if (strategy === 'mergebot') {
    const spinner = createSpinner('Posting /merge comment...').start();
    try {
      github.commentOnPr(prNumber, '/merge');
      spinner.stop();
      showSuccess('Posted /merge comment');
      console.log(chalk.dim('  Merge automation will process shortly.'));
    } catch (error) {
      spinner.fail('Failed to post comment');
      console.error(chalk.red(String(error)));
    }
  } else {
    const spinner = createSpinner(`Merging PR #${prNumber} (--${strategy})...`).start();
    try {
      github.mergePr(prNumber, strategy);
      spinner.succeed(`PR #${prNumber} merged (${strategy})`);
    } catch (error) {
      spinner.fail('Failed to merge PR');
      console.error(chalk.red(String(error)));
    }
  }
}

async function updateTicketOnMerge(prNumber: number, strategy: MergeStrategy): Promise<void> {
  const ticketId = extractTicketIdFromBranch(git.currentBranch());
  if (!ticketId) return;

  try {
    const config = loadConfig();
    const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);
    const task = await clickup.getTask(ticketId);

    if (strategy === 'mergebot') {
      // Phase 1: Set to "awaiting merge" immediately
      const requestStatus = await resolveStatus(clickup, task, config.clickup.defaults.statusOnMergeRequest, MERGE_REQUEST_PATTERNS);
      if (requestStatus && task.status.status.toLowerCase() !== requestStatus.toLowerCase()) {
        await clickup.updateTask(ticketId, { status: requestStatus });
        showSuccess(`Ticket status → ${requestStatus.toUpperCase()}`);
      }

      // Phase 2: Poll for merge completion (up to 60s)
      const merged = await waitForMerge(prNumber, 60);

      if (merged) {
        await finalizeTicket(clickup, ticketId, prNumber);
      } else {
        showWarning('Merge not yet confirmed. Ticket left at current status.');
        console.log(chalk.dim('  Run `workon context` later to check.'));
      }
    } else {
      // Direct merge — PR is already merged
      await finalizeTicket(clickup, ticketId, prNumber);
    }
  } catch (error) {
    showWarning(`Failed to update ticket: ${error}`);
  }
}

async function finalizeTicket(
  clickup: ReturnType<typeof createClickUpClient>,
  ticketId: string,
  prNumber: number,
): Promise<void> {
  const config = loadConfig();
  const freshTask = await clickup.getTask(ticketId);
  const mergeStatus = await resolveStatus(clickup, freshTask, config.clickup.defaults.statusOnMerge, MERGE_PATTERNS);
  if (mergeStatus && freshTask.status.status.toLowerCase() !== mergeStatus.toLowerCase()) {
    await clickup.updateTask(ticketId, { status: mergeStatus });
    showSuccess(`Ticket status → ${mergeStatus.toUpperCase()}`);
  }

  await clickup.commentOnTask(ticketId, `Merged in PR #${prNumber}`);
  showSuccess('Commented on ticket');

  // Auto-cleanup: switch to base, pull, delete feature branch
  console.log('');
  await cleanupCommand({ yes: true });
}

async function waitForMerge(prNumber: number, timeoutSeconds: number): Promise<boolean> {
  const spinner = createSpinner('Waiting for merge to complete...').start();
  const interval = 5000;
  const maxAttempts = Math.ceil((timeoutSeconds * 1000) / interval);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const state = github.getPrState(prNumber);
      if (state === 'MERGED') {
        spinner.succeed('PR merged');
        return true;
      }
      if (state === 'CLOSED') {
        spinner.warn('PR was closed without merging');
        return false;
      }
    } catch {
      // gh CLI error — continue polling
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  spinner.stop();
  return false;
}
