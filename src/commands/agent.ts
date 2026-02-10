import chalk from 'chalk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import * as github from '../services/github.js';
import { validateCommand } from './validate.js';
import { showSuccess, showWarning, showInfo, createSpinner } from '../utils/ui.js';
import type { Config, ClickUpTask } from '../types.js';
import type { ClickUpClient } from '../services/clickup.js';

export interface AgentCommandOptions {
  interval?: string;
  once?: boolean;
  statuses?: string[];
}

interface AgentEvent {
  type: 'new-task' | 'task-needs-info' | 'pr-review' | 'ci-failure';
  taskId?: string;
  taskName?: string;
  prNumber?: number;
  message: string;
}

const DEFAULT_INTERVAL_SECONDS = 300; // 5 minutes

// Statuses that indicate a task is ready for an agent to pick up
const DEFAULT_READY_STATUSES = ['on deck', 'ready for eng', 'open', 'to do'];

const AGENT_STATE_PATH = join(process.env.HOME || '.', '.workon', 'agent-state.json');

interface AgentState {
  processedTasks: string[];
  processedPrReviews: string[];
}

function loadAgentState(): { processedTasks: Set<string>; processedPrReviews: Set<string> } {
  try {
    if (existsSync(AGENT_STATE_PATH)) {
      const raw = readFileSync(AGENT_STATE_PATH, 'utf-8');
      const state: AgentState = JSON.parse(raw);
      return {
        processedTasks: new Set(state.processedTasks ?? []),
        processedPrReviews: new Set(state.processedPrReviews ?? []),
      };
    }
  } catch {
    // Corrupted state file — start fresh
  }
  return { processedTasks: new Set(), processedPrReviews: new Set() };
}

function saveAgentState(processedTasks: Set<string>, processedPrReviews: Set<string>): void {
  const state: AgentState = {
    processedTasks: [...processedTasks],
    processedPrReviews: [...processedPrReviews],
  };
  mkdirSync(dirname(AGENT_STATE_PATH), { recursive: true });
  writeFileSync(AGENT_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

export async function agentCommand(options: AgentCommandOptions = {}): Promise<void> {
  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);
  const intervalSeconds = options.interval ? parseInt(options.interval, 10) : DEFAULT_INTERVAL_SECONDS;

  if (isNaN(intervalSeconds) || intervalSeconds < 10) {
    console.error(chalk.red('Interval must be at least 10 seconds.'));
    process.exit(1);
  }

  const readyStatuses = options.statuses ?? DEFAULT_READY_STATUSES;

  console.log(chalk.bold('\n--- workon agent ---\n'));
  showInfo(`Polling interval: ${intervalSeconds}s`);
  showInfo(`Watching statuses: ${readyStatuses.join(', ')}`);
  if (options.once) {
    showInfo('Mode: single pass (--once)');
  }
  console.log('');

  // Load previously processed IDs from disk to survive restarts
  const { processedTasks, processedPrReviews } = loadAgentState();

  if (options.once) {
    await pollOnce(config, clickup, readyStatuses, processedTasks, processedPrReviews);
    saveAgentState(processedTasks, processedPrReviews);
    return;
  }

  // Continuous polling loop
  while (true) {
    await pollOnce(config, clickup, readyStatuses, processedTasks, processedPrReviews);
    saveAgentState(processedTasks, processedPrReviews);

    console.log(chalk.dim(`\nNext poll in ${intervalSeconds}s... (Ctrl+C to stop)\n`));
    await sleep(intervalSeconds * 1000);
  }
}

async function pollOnce(
  config: Config,
  clickup: ClickUpClient,
  readyStatuses: string[],
  processedTasks: Set<string>,
  processedPrReviews: Set<string>,
): Promise<void> {
  const timestamp = new Date().toLocaleTimeString();
  console.log(chalk.dim(`[${timestamp}] Polling...`));

  const events: AgentEvent[] = [];

  // 1. Check for new assigned tasks
  const taskEvents = await checkNewTasks(config, clickup, readyStatuses, processedTasks);
  events.push(...taskEvents);

  // 2. Check PRs for review feedback (only if gh is available)
  if (github.isGhAvailable()) {
    const prEvents = await checkPrReviews(processedPrReviews);
    events.push(...prEvents);
  }

  // Report findings
  if (events.length === 0) {
    console.log(chalk.dim('  No new events.'));
  } else {
    console.log(chalk.bold(`  Found ${events.length} event${events.length !== 1 ? 's' : ''}:`));
    for (const event of events) {
      const icon = eventIcon(event.type);
      console.log(`  ${icon} ${event.message}`);
    }
  }
}

async function checkNewTasks(
  config: Config,
  clickup: ClickUpClient,
  readyStatuses: string[],
  processedTasks: Set<string>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  try {
    const spinner = createSpinner('Checking assigned tasks...').start();
    const tasks = await clickup.getMyTasks(config.clickup.userId, 50);
    spinner.stop();

    // Filter to tasks in ready statuses
    const readyTasks = tasks.filter(task =>
      readyStatuses.some(s => task.status.status.toLowerCase() === s.toLowerCase())
    );

    for (const task of readyTasks) {
      if (processedTasks.has(task.id)) continue;
      processedTasks.add(task.id);

      // Validate each new task
      const validation = await validateTask(task, config, clickup);

      if (validation === 'ready') {
        events.push({
          type: 'new-task',
          taskId: task.id,
          taskName: task.name,
          message: `${chalk.green('Ready')}: ${task.name} (${task.id})`,
        });
      } else {
        events.push({
          type: 'task-needs-info',
          taskId: task.id,
          taskName: task.name,
          message: `${chalk.yellow('Needs info')}: ${task.name} (${task.id}) — commented on ticket`,
        });
      }
    }
  } catch (error) {
    showWarning(`Failed to check tasks: ${error}`);
  }

  return events;
}

async function validateTask(
  task: ClickUpTask,
  config: Config,
  clickup: ClickUpClient,
): Promise<'ready' | 'needs-info'> {
  try {
    const result = await validateCommand(task.id, { json: false, comment: false, deep: config.ai.enabled, hierarchy: true });

    if (!result) return 'needs-info';

    if (result.ready) {
      return 'ready';
    }

    // Task has issues — post a comment asking for clarification
    const lines = [
      'This ticket needs the following before work can begin:',
      '',
      ...result.issues.map(i => `- ${i}`),
    ];
    if (result.warnings.length > 0) {
      lines.push('', 'Additionally:', '', ...result.warnings.map(w => `- ${w}`));
    }

    // Include hierarchy findings if present
    if (result.hierarchyFindings && result.hierarchyFindings.length > 0) {
      lines.push('', '**Hierarchy issues:**', '');
      for (const f of result.hierarchyFindings) {
        const target = f.ticketId ? ` (${f.ticketId})` : '';
        lines.push(`- **[${f.category}]** ${f.message}${target}`);
        lines.push(`  _→ ${f.recommendation}_`);
      }
    }

    await clickup.commentOnTask(task.id, lines.join('\n'));
    showInfo(`  Commented on ${task.id}: missing requirements`);

    return 'needs-info';
  } catch {
    return 'needs-info';
  }
}

async function checkPrReviews(
  processedPrReviews: Set<string>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  try {
    // Check if there's a PR for the current branch
    const pr = github.getPrForCurrentBranch();
    if (!pr) return events;

    const status = github.getPrStatus(pr.number);

    // Check for changes requested
    const changesRequested = status.reviews
      .filter(r => r.state === 'CHANGES_REQUESTED')
      .map(r => r.author);

    if (changesRequested.length > 0) {
      const key = `${pr.number}-changes-${changesRequested.sort().join(',')}`;
      if (!processedPrReviews.has(key)) {
        processedPrReviews.add(key);
        events.push({
          type: 'pr-review',
          prNumber: pr.number,
          message: `${chalk.red('Changes requested')} on PR #${pr.number} by ${changesRequested.join(', ')}`,
        });
      }
    }

    // Check for CI failures
    const ciFailed = status.checks.filter(c => c.conclusion === 'failure');
    if (ciFailed.length > 0) {
      const key = `${pr.number}-ci-${ciFailed.map(c => c.name).sort().join(',')}`;
      if (!processedPrReviews.has(key)) {
        processedPrReviews.add(key);
        events.push({
          type: 'ci-failure',
          prNumber: pr.number,
          message: `${chalk.red('CI failed')} on PR #${pr.number}: ${ciFailed.map(c => c.name).join(', ')}`,
        });
      }
    }
  } catch {
    // PR check failed silently — may not be on a feature branch
  }

  return events;
}

function eventIcon(type: AgentEvent['type']): string {
  switch (type) {
    case 'new-task': return chalk.green('●');
    case 'task-needs-info': return chalk.yellow('●');
    case 'pr-review': return chalk.red('●');
    case 'ci-failure': return chalk.red('●');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
