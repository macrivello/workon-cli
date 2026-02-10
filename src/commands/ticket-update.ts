import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import { createClickUpClient } from '../services/clickup.js';
import { createSpinner } from '../utils/ui.js';
import { isStdinPiped, readStdin } from '../utils/stdin.js';
import * as git from '../services/git.js';

export interface TicketUpdateOptions {
  status?: string;
  description?: string;
  name?: string;
}

export async function ticketUpdateCommand(ticketIdArg?: string, options: TicketUpdateOptions = {}): Promise<void> {
  // Resolve ticket ID
  let ticketId = ticketIdArg;
  if (!ticketId) {
    if (!git.isGitRepo()) {
      console.error(chalk.red('Not in a git repository and no ticket ID provided.'));
      process.exit(1);
    }
    ticketId = extractTicketIdFromBranch(git.currentBranch()) ?? undefined;
    if (!ticketId) {
      console.error(chalk.red('Could not extract ticket ID from branch. Provide one as an argument.'));
      process.exit(1);
    }
  }

  // Read description from stdin if "-" was passed
  let description = options.description;
  if (description === '-') {
    if (!isStdinPiped()) {
      console.error(chalk.red('--description - requires piped stdin input.'));
      process.exit(1);
    }
    description = await readStdin();
  }

  // Build updates object
  const updates: { name?: string; markdown_description?: string; status?: string } = {};
  if (options.name) updates.name = options.name;
  if (description) updates.markdown_description = description;
  if (options.status) updates.status = options.status;

  if (Object.keys(updates).length === 0) {
    console.error(chalk.red('At least one update flag is required (--status, --description, or --name).'));
    process.exit(1);
  }

  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);

  const spinner = createSpinner(`Updating ticket ${ticketId}...`).start();

  try {
    await clickup.updateTask(ticketId, updates);
    spinner.succeed(`Updated ticket ${ticketId}`);

    const updated: string[] = [];
    if (updates.status) updated.push(`status → ${updates.status}`);
    if (updates.name) updated.push(`name → ${updates.name}`);
    if (updates.markdown_description) updated.push('description updated');
    console.log(chalk.dim(`  ${updated.join(', ')}`));
  } catch (error) {
    spinner.fail(`Failed to update ticket ${ticketId}`);
    console.error(chalk.red(error));
    process.exit(1);
  }
}
