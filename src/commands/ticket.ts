import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import { fetchEnrichedTicket, renderMarkdown, renderJSON } from '../utils/ticket-file.js';
import * as git from '../services/git.js';

export interface TicketCommandOptions {
  json?: boolean;
  markdown?: boolean;
}

export async function ticketCommand(ticketIdArg?: string, options?: TicketCommandOptions): Promise<void> {
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

  try {
    // Structured output modes fetch enriched data (comments + subtasks)
    if (options?.json || options?.markdown) {
      const enriched = await fetchEnrichedTicket(clickup, ticketId);

      if (options.json) {
        console.log(renderJSON(enriched));
      } else {
        console.log(renderMarkdown(enriched));
      }
      return;
    }

    // Default: human-readable console output
    const task = await clickup.getTask(ticketId);

    // Output ticket info in a format useful for Claude Code
    console.log(chalk.bold.cyan(`# ${task.name}`));
    console.log('');
    console.log(chalk.dim(`ID: ${task.id}`));
    console.log(chalk.dim(`Status: ${task.status.status}`));
    console.log(chalk.dim(`URL: ${task.url}`));
    console.log('');

    if (task.text_content || task.description) {
      console.log(chalk.bold('## Description'));
      console.log('');
      console.log(task.text_content || task.description || '(No description)');
    } else {
      console.log(chalk.yellow('(No description)'));
    }
  } catch (error) {
    console.error(chalk.red(`Failed to fetch ticket ${ticketId}:`), error);
    process.exit(1);
  }
}
