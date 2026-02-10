import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { createSpinner, showSuccess } from '../utils/ui.js';
import { readStdin, isStdinPiped } from '../utils/stdin.js';
import { startCommand } from './start.js';

export interface TicketCreateOptions {
  name: string;
  description?: string;
  list?: string;
  status?: string;
  start?: boolean;
}

export async function ticketCreateCommand(options: TicketCreateOptions): Promise<void> {
  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);

  // Handle stdin for description
  let description = options.description || '';
  if (description === '-') {
    if (!isStdinPiped()) {
      console.error(chalk.red('Stdin ("-") specified for description but no input piped.'));
      process.exit(1);
    }
    description = await readStdin();
  }

  // Determine list ID: explicit flag, or first workspace's folder's first list
  let listId = options.list;
  if (!listId) {
    const workspaceNames = Object.keys(config.clickup.workspaces);
    if (workspaceNames.length === 0) {
      console.error(chalk.red('No workspaces configured. Use --list <id> to specify a list.'));
      process.exit(1);
    }
    const workspace = config.clickup.workspaces[workspaceNames[0]];
    const lists = await clickup.getLists(workspace.folderId);
    if (lists.length === 0) {
      console.error(chalk.red('No lists found in workspace folder. Use --list <id> to specify a list.'));
      process.exit(1);
    }
    listId = lists[0].id;
  }

  const spinner = createSpinner('Creating ticket...').start();

  try {
    const task = await clickup.createTask(listId, {
      name: options.name,
      markdown_description: description || undefined,
      assignees: [parseInt(config.clickup.userId, 10)],
      status: options.status || config.clickup.defaults.status,
    });

    spinner.succeed(`Created ticket: ${task.id}`);
    console.log(`  ${task.name}`);
    console.log(`  ${chalk.blue(task.url)}`);

    if (options.start) {
      console.log('');
      await startCommand(task.id, { yes: true });
    }
  } catch (error) {
    spinner.fail('Failed to create ticket');
    console.error(chalk.red(error));
    process.exit(1);
  }
}
