import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import { getPlatform, resolveRepoPath } from '../utils/platform.js';
import * as git from '../services/git.js';
import { createSpinner } from '../utils/ui.js';

export interface SubtasksCommandOptions {
  json?: boolean;
}

export async function subtasksCommand(ticketIdArg?: string, options?: SubtasksCommandOptions): Promise<void> {
  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);

  let ticketId = ticketIdArg;

  // If no ticket ID provided, try to extract from current branch
  if (!ticketId) {
    if (!git.isGitRepo()) {
      console.error(chalk.red('Not in a git repository and no ticket ID provided.'));
      process.exit(1);
    }

    const branch = git.currentBranch();
    const extractedId = extractTicketIdFromBranch(branch);

    if (!extractedId) {
      console.error(chalk.red('Could not extract ticket ID from branch name.'));
      console.error(chalk.yellow(`Expected format: ${config.git.branchPrefix}/{ticketid}/description`));
      process.exit(1);
    }

    ticketId = extractedId;
  }

  const spinner = options?.json ? null : createSpinner('Fetching subtasks...').start();

  try {
    const subtasks = await clickup.getTaskSubtasks(ticketId);

    if (spinner) spinner.stop();

    // Enrich subtasks with platform + repo info
    const enriched = subtasks.map(subtask => {
      const platform = getPlatform(subtask.custom_fields) || null;
      const repoPath = platform && config.repos
        ? resolveRepoPath(platform, config.repos)
        : null;
      return { ...subtask, platform, repoPath };
    });

    if (options?.json) {
      console.log(JSON.stringify(enriched, null, 2));
      return;
    }

    if (enriched.length === 0) {
      console.log(chalk.yellow(`No subtasks found for ${ticketId}.`));
      return;
    }

    for (const subtask of enriched) {
      const status = subtask.status.status;
      const platformTag = subtask.platform ? chalk.blue(` [${subtask.platform}]`) : '';
      const repoTag = subtask.repoPath ? chalk.dim(` → ${subtask.repoPath}`) : '';
      console.log(`${subtask.id} ${chalk.dim(`[${status}]`)}${platformTag} ${subtask.name}${repoTag}`);
    }
  } catch (error) {
    if (spinner) spinner.fail('Failed to fetch subtasks');
    console.error(chalk.red(error));
    process.exit(1);
  }
}
