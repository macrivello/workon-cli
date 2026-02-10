import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { createSpinner } from '../utils/ui.js';

export interface TasksCommandOptions {
  json?: boolean;
  limit?: string;
  status?: string[];
}

export async function tasksCommand(options: TasksCommandOptions): Promise<void> {
  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);

  const limit = options.limit ? parseInt(options.limit, 10) : 20;

  const spinner = options.json ? null : createSpinner('Fetching tasks...').start();

  try {
    let tasks = await clickup.getMyTasks(config.clickup.userId, limit);

    // Filter by status if specified
    if (options.status && options.status.length > 0) {
      const statusFilters = options.status.map(s => s.toLowerCase());
      tasks = tasks.filter(t => statusFilters.some(f => t.status.status.toLowerCase().includes(f)));
    }

    if (spinner) spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    if (tasks.length === 0) {
      console.log(chalk.yellow('No tasks found.'));
      return;
    }

    for (const task of tasks) {
      const status = task.status.status;
      console.log(`${task.id} ${chalk.dim(`[${status}]`)} ${task.name}`);
    }
  } catch (error) {
    if (spinner) spinner.fail('Failed to fetch tasks');
    console.error(chalk.red(error));
    process.exit(1);
  }
}
