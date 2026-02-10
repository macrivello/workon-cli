import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { createSpinner, showSuccess, showWarning } from '../utils/ui.js';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import { resolveStatus, PR_PATTERNS } from '../utils/ticket-status.js';
import * as git from '../services/git.js';
import * as github from '../services/github.js';

export interface PrReadyCommandOptions {
  yes?: boolean;
}

export async function prReadyCommand(prNumberArg?: string, options: PrReadyCommandOptions = {}): Promise<void> {
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

  const pr = github.getPr(prNumber);
  console.log(chalk.bold(`PR #${pr.number}: ${pr.title}`));

  if (!github.isPrDraft(prNumber)) {
    console.log(chalk.yellow(`PR #${prNumber} is already marked as ready for review.`));
    return;
  }

  const shouldProceed = options.yes || await confirm({
    message: 'Mark this PR as ready for review?',
    default: true,
  });

  if (!shouldProceed) {
    return;
  }

  const spinner = createSpinner('Marking PR as ready for review...').start();

  try {
    github.markPrReady(prNumber);
    spinner.stop();
    showSuccess(`PR #${prNumber} marked as ready for review.`);

    // Update ticket status to "in review"
    const ticketId = extractTicketIdFromBranch(git.currentBranch());
    if (ticketId) {
      try {
        const config = loadConfig();
        const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);
        const task = await clickup.getTask(ticketId);

        const status = await resolveStatus(clickup, task, config.clickup.defaults.statusOnPr, PR_PATTERNS);
        if (status && task.status.status.toLowerCase() !== status.toLowerCase()) {
          await clickup.updateTask(ticketId, { status });
          showSuccess(`Ticket status → ${status.toUpperCase()}`);
        }
      } catch (error) {
        showWarning(`Failed to update ticket: ${error}`);
      }
    }
  } catch (error) {
    spinner.fail('Failed to mark PR as ready');
    console.error(chalk.red(error));
  }
}
