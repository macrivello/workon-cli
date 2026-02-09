import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { createSpinner } from '../utils/ui.js';
import { startCommand } from './start.js';

export async function nextCommand(options: { limit?: string } = {}): Promise<void> {
  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);
  const limit = options.limit ? parseInt(options.limit, 10) : 10;

  const spinner = createSpinner('Fetching your tasks...').start();

  try {
    const tasks = await clickup.getMyTasks(config.clickup.userId, limit);
    spinner.stop();

    // Filter to actionable statuses (exclude "in review", "closed", "done", etc.)
    const nonActionable = /closed|done|complete|resolved|merged|in.?review|code.?review/i;
    const actionable = tasks.filter(t => !nonActionable.test(t.status.status));

    if (actionable.length === 0) {
      console.log(chalk.yellow('No actionable tasks found.'));
      return;
    }

    const ticketId = await select({
      message: 'Pick your next task:',
      choices: actionable.map(t => ({
        name: `${chalk.dim(`[${t.status.status}]`)} ${t.name}`,
        value: t.id,
      })),
    });

    await startCommand(ticketId, { yes: true });
  } catch (error) {
    spinner.stop();
    console.error(chalk.red('Failed to fetch tasks:'), error);
  }
}
