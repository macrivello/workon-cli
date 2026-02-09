import chalk from 'chalk';
import { createSpinner, showSuccess } from '../utils/ui.js';
import * as git from '../services/git.js';
import * as github from '../services/github.js';
import { isStdinPiped, readStdin } from '../utils/stdin.js';

export interface PrCommentCommandOptions {
  replyTo?: string;
  body?: string;
}

export async function prCommentCommand(prNumberArg?: string, options: PrCommentCommandOptions = {}): Promise<void> {
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

  if (!options.replyTo) {
    console.error(chalk.red('--reply-to <comment-id> is required.'));
    process.exit(1);
  }

  const commentId = parseInt(options.replyTo, 10);

  // Resolve body: --body flag, or stdin
  let body = options.body;
  if (body === '-' || (!body && isStdinPiped())) {
    body = await readStdin();
  }

  if (!body) {
    console.error(chalk.red('Reply body is required. Use --body <text> or pipe via stdin.'));
    process.exit(1);
  }

  const spinner = createSpinner('Posting reply...').start();

  try {
    github.replyToReviewComment(prNumber, commentId, body);
    spinner.stop();
    showSuccess(`Replied to comment #${commentId} on PR #${prNumber}.`);
  } catch (error) {
    spinner.fail('Failed to post reply');
    console.error(chalk.red(error));
  }
}
