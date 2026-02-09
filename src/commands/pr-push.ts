import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { createSpinner, showSuccess, showWarning } from '../utils/ui.js';
import * as git from '../services/git.js';
import * as github from '../services/github.js';

export interface PrPushCommandOptions {
  yes?: boolean;
}

export async function prPushCommand(prNumberArg?: string, options: PrPushCommandOptions = {}): Promise<void> {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  if (!github.isGhAvailable()) {
    console.error(chalk.red('GitHub CLI (gh) is not available.'));
    process.exit(1);
  }

  // Check for uncommitted changes
  if (git.hasUncommittedChanges()) {
    showWarning('You have uncommitted changes.');
    const shouldContinue = options.yes || await confirm({
      message: 'Continue with push anyway?',
      default: false,
    });
    if (!shouldContinue) {
      return;
    }
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

  const shouldProceed = options.yes || await confirm({
    message: `Push and re-request review on PR #${prNumber}?`,
    default: true,
  });

  if (!shouldProceed) {
    return;
  }

  // Push
  const pushSpinner = createSpinner('Pushing...').start();

  try {
    github.pushBranch();
    pushSpinner.stop();
    showSuccess('Pushed.');
  } catch (error) {
    pushSpinner.fail('Failed to push');
    console.error(chalk.red(error));
    return;
  }

  // Re-request reviewers
  const reviewSpinner = createSpinner('Re-requesting reviewers...').start();

  try {
    const status = github.getPrStatus(prNumber);
    const reviewers = [...new Set(
      status.reviews
        .filter(r => r.state !== 'PENDING')
        .map(r => r.author)
    )];

    if (reviewers.length === 0) {
      reviewSpinner.stop();
      console.log(chalk.dim('No previous reviewers to re-request.'));
      return;
    }

    github.requestReviewers(prNumber, reviewers);
    reviewSpinner.stop();
    showSuccess(`Re-requested review from ${reviewers.map(r => `@${r}`).join(', ')}.`);
  } catch (error) {
    reviewSpinner.fail('Failed to re-request reviewers');
    console.error(chalk.red(error));
  }
}
