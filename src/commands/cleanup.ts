import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { showSuccess, showWarning } from '../utils/ui.js';
import * as git from '../services/git.js';
import { updateStatus } from '../utils/worktree-status.js';

export async function cleanupCommand(options: { yes?: boolean } = {}): Promise<void> {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  // Handle linked worktree: remove worktree + branch instead of normal cleanup
  if (git.isWorktree()) {
    const worktreeRoot = git.repoRoot();
    const currentBranch = git.currentBranch();

    if (git.worktreeHasChanges(worktreeRoot)) {
      showWarning('Worktree has uncommitted changes that will be lost.');
    }
    showWarning('You are inside a linked worktree.');
    const shouldRemove = options.yes || await confirm({
      message: `Remove worktree at ${chalk.cyan(worktreeRoot)} and delete branch ${chalk.cyan(currentBranch)}?`,
      default: true,
    });
    if (!shouldRemove) return;

    // Mark status as completed
    try {
      updateStatus({ stage: 'completed' });
    } catch {
      // No status file — that's fine
    }

    // Must leave worktree before removing it
    const mainPath = git.mainWorktreePath();
    process.chdir(mainPath);
    showSuccess(`Changed to main worktree: ${mainPath}`);

    try {
      git.worktreeRemove(worktreeRoot);
      showSuccess(`Removed worktree: ${worktreeRoot}`);

      git.deleteBranch(currentBranch);
      showSuccess(`Deleted branch: ${currentBranch}`);
    } catch (error) {
      console.error(chalk.red(`Worktree cleanup failed: ${error}`));
    }
    return;
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
