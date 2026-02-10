import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { showSuccess, showWarning } from '../utils/ui.js';
import * as git from '../services/git.js';

export async function cleanupCommand(options: { yes?: boolean } = {}): Promise<void> {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  const currentBranch = git.currentBranch();
  const baseBranch = git.getDefaultBaseBranch();

  if (git.isBaseBranch()) {
    console.log(chalk.yellow(`Already on ${baseBranch}. Nothing to clean up.`));
    return;
  }

  if (git.hasUncommittedChanges()) {
    showWarning('You have uncommitted changes on this branch.');
    const proceed = options.yes || await confirm({
      message: 'Continue anyway? (uncommitted changes will be lost)',
      default: false,
    });
    if (!proceed) return;
  }

  const shouldCleanup = options.yes || await confirm({
    message: `Switch to ${baseBranch}, pull, and delete branch ${chalk.cyan(currentBranch)}?`,
    default: true,
  });

  if (!shouldCleanup) return;

  try {
    git.checkout(baseBranch);
    showSuccess(`Switched to ${baseBranch}`);

    git.pull();
    showSuccess(`Pulled latest ${baseBranch}`);

    git.deleteBranch(currentBranch);
    showSuccess(`Deleted branch ${currentBranch}`);
  } catch (error) {
    console.error(chalk.red(`Cleanup failed: ${error}`));
  }
}
