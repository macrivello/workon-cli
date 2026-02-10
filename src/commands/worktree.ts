import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { generateBranchName, isTicketId } from '../utils/branch.js';
import { createSpinner, showSuccess, showWarning } from '../utils/ui.js';
import { resolveStatus, START_PATTERNS } from '../utils/ticket-status.js';
import * as git from '../services/git.js';
import {
  writeStatusTo,
  readAllStatuses,
  readStatus,
  createInitialStatus,
  updateStatus as updateWorktreeStatus,
  worktreesDir,
  worktreePathForTicket,
} from '../utils/worktree-status.js';
import type { WorktreePipelineStage } from '../types.js';

const VALID_STAGES: WorktreePipelineStage[] = [
  'starting', 'planning', 'implementing', 'pr-created',
  'ci-fixing', 'review-addressing', 'ready-to-merge',
  'blocked', 'completed',
];

export interface WorktreeAddOptions {
  yes?: boolean;
}

export interface WorktreeListOptions {
  json?: boolean;
}

export interface WorktreeRemoveOptions {
  yes?: boolean;
  keep?: boolean;
}

export interface WorktreeStatusOptions {
  json?: boolean;
}

export interface WorktreeUpdateStatusOptions {
  stage?: string;
  blocked?: string;
  prUrl?: string;
  prNumber?: string;
}

export async function worktreeAddCommand(ticketId: string, options: WorktreeAddOptions = {}): Promise<void> {
  if (!ticketId || !isTicketId(ticketId)) {
    console.error(chalk.red('Invalid ticket ID.'));
    process.exit(1);
  }

  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);

  // Check if worktree already exists
  const wtPath = worktreePathForTicket(ticketId);
  if (existsSync(wtPath)) {
    const status = readStatus(wtPath);
    if (status) {
      console.log(chalk.yellow(`Worktree already exists for ${ticketId}`));
      console.log(`  Stage: ${stageBadge(status.stage)}`);
      if (status.prUrl) console.log(`  PR: ${chalk.blue(status.prUrl)}`);
    } else {
      console.log(chalk.yellow(`Worktree already exists at ${wtPath}`));
    }
    // Print path as last line for scripting
    console.log(wtPath);
    return;
  }

  // Fetch ticket
  const spinner = createSpinner('Fetching ticket...').start();
  let ticket;
  try {
    ticket = await clickup.getTask(ticketId);
    spinner.succeed(`Found: ${ticket.name}`);
  } catch (error) {
    spinner.fail('Failed to fetch ticket');
    console.error(chalk.red(String(error)));
    process.exit(1);
  }

  // Generate branch name
  const branchName = generateBranchName(config.git.branchPrefix, ticketId, ticket.name);

  // Ensure .worktrees/ dir exists
  const baseDir = worktreesDir();
  mkdirSync(baseDir, { recursive: true });

  // Ensure .worktrees/ and .workon-status.json are gitignored
  ensureGitignore(git.mainWorktreePath());

  // Create worktree
  try {
    git.worktreeAdd(wtPath, branchName);
    showSuccess(`Created worktree at ${chalk.cyan(wtPath)}`);
    showSuccess(`Branch: ${chalk.cyan(branchName)}`);
  } catch (error) {
    console.error(chalk.red(`Failed to create worktree: ${error}`));
    process.exit(1);
  }

  // Write initial status
  const status = createInitialStatus(ticketId, ticket.name, branchName);
  writeStatusTo(wtPath, status);

  // Update ClickUp ticket status
  try {
    const targetStatus = await resolveStatus(clickup, ticket, config.clickup.defaults.statusOnStart, START_PATTERNS);
    if (targetStatus && ticket.status.status.toLowerCase() !== targetStatus.toLowerCase()) {
      await clickup.updateTask(ticket.id, { status: targetStatus });
      showSuccess(`Ticket status → ${targetStatus.toUpperCase()}`);
    }
  } catch (error) {
    showWarning(`Failed to update ticket status: ${error}`);
  }

  // Print path as last line for scripting: claude --cwd $(workon worktree add <id> | tail -1)
  console.log(wtPath);
}

export function worktreeListCommand(options: WorktreeListOptions = {}): void {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  const allInfo = readAllStatuses();
  const linked = allInfo.filter(w => !w.isMain);

  if (options.json) {
    console.log(JSON.stringify(linked, null, 2));
    return;
  }

  if (linked.length === 0) {
    console.log(chalk.dim('No linked worktrees.'));
    return;
  }

  console.log(chalk.bold('\nBackground Worktrees\n'));
  for (const wt of linked) {
    const id = wt.ticketId || chalk.dim('unknown');
    const stage = wt.status ? stageBadge(wt.status.stage) : chalk.dim('[no status]');
    const name = wt.status?.ticketName || '';
    const pr = wt.status?.prUrl ? ` | ${chalk.blue(wt.status.prUrl)}` : '';
    console.log(`  ${id}  ${stage}  ${name}${pr}`);
    console.log(`  ${chalk.dim(wt.path)}`);
    console.log('');
  }
}

export async function worktreeRemoveCommand(ticketId: string, options: WorktreeRemoveOptions = {}): Promise<void> {
  if (!ticketId || !isTicketId(ticketId)) {
    console.error(chalk.red('Invalid ticket ID.'));
    process.exit(1);
  }

  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  const wtPath = worktreePathForTicket(ticketId);
  if (!existsSync(wtPath)) {
    console.error(chalk.red(`No worktree found for ticket ${ticketId}`));
    process.exit(1);
  }

  const status = readStatus(wtPath);

  // Warn about uncommitted changes that would be lost
  if (git.worktreeHasChanges(wtPath)) {
    showWarning('Worktree has uncommitted changes that will be lost.');
  }

  if (status && status.stage !== 'completed') {
    showWarning(`Worktree stage is "${status.stage}", not completed.`);
    const proceed = options.yes || await confirm({
      message: 'Remove anyway?',
      default: false,
    });
    if (!proceed) return;
  }

  // Get the branch name before removing
  const allInfo = readAllStatuses();
  const entry = allInfo.find(w => w.path === wtPath);
  const branch = entry?.branch;

  try {
    git.worktreeRemove(wtPath);
    showSuccess(`Removed worktree for ${ticketId}`);
  } catch (error) {
    console.error(chalk.red(`Failed to remove worktree: ${error}`));
    process.exit(1);
  }

  // Delete branch unless --keep
  if (branch && !options.keep) {
    try {
      git.deleteBranch(branch);
      showSuccess(`Deleted branch ${branch}`);
    } catch {
      // Branch may already be deleted or not exist
    }
  }
}

export function worktreeStatusCommand(ticketId?: string, options: WorktreeStatusOptions = {}): void {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  if (!ticketId) {
    return worktreeListCommand(options);
  }

  const wtPath = worktreePathForTicket(ticketId);
  const status = readStatus(wtPath);

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!status) {
    console.log(chalk.dim(`No status found for ticket ${ticketId}`));
    return;
  }

  console.log(chalk.bold(`\nWorktree Status: ${ticketId}\n`));
  console.log(`  Ticket:  ${status.ticketName}`);
  console.log(`  Branch:  ${chalk.cyan(status.branch)}`);
  console.log(`  Stage:   ${stageBadge(status.stage)}`);
  if (status.prUrl) console.log(`  PR:      ${chalk.blue(status.prUrl)}`);
  if (status.prNumber) console.log(`  PR #:    ${status.prNumber}`);
  if (status.blockedReason) console.log(`  Blocked: ${chalk.red(status.blockedReason)}`);
  console.log(`  Started: ${status.startedAt}`);
  console.log(`  Updated: ${status.updatedAt}`);
  if (status.completedAt) console.log(`  Done:    ${status.completedAt}`);
  console.log(`  Path:    ${chalk.dim(wtPath)}`);
  console.log('');
}

export function worktreeUpdateStatusCommand(options: WorktreeUpdateStatusOptions): void {
  if (!git.isGitRepo()) {
    console.error(chalk.red('Not in a git repository.'));
    process.exit(1);
  }

  if (!options.stage) {
    console.error(chalk.red('--stage is required'));
    process.exit(1);
  }

  if (!VALID_STAGES.includes(options.stage as WorktreePipelineStage)) {
    console.error(chalk.red(`Invalid stage: ${options.stage}`));
    console.error(chalk.dim(`Valid stages: ${VALID_STAGES.join(', ')}`));
    process.exit(1);
  }

  const updates: Parameters<typeof updateWorktreeStatus>[0] = {
    stage: options.stage as WorktreePipelineStage,
  };

  if (options.blocked) updates.blockedReason = options.blocked;
  if (options.prUrl) updates.prUrl = options.prUrl;
  if (options.prNumber) updates.prNumber = parseInt(options.prNumber, 10);

  try {
    updateWorktreeStatus(updates);
    showSuccess(`Stage → ${options.stage}`);
  } catch (error) {
    console.error(chalk.red(String(error)));
    process.exit(1);
  }
}

/**
 * Idempotently ensure .worktrees/ and .workon-status.json are in .gitignore
 */
function ensureGitignore(repoRoot: string): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const entries = ['.worktrees/', '.workon-status.json'];

  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }

  const missing = entries.filter(e => !content.split('\n').some(line => line.trim() === e));
  if (missing.length === 0) return;

  const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  appendFileSync(gitignorePath, suffix + missing.join('\n') + '\n', 'utf-8');
}

function stageBadge(stage: WorktreePipelineStage): string {
  const colors: Record<WorktreePipelineStage, (s: string) => string> = {
    'starting': chalk.dim,
    'planning': chalk.blue,
    'implementing': chalk.cyan,
    'pr-created': chalk.magenta,
    'ci-fixing': chalk.yellow,
    'review-addressing': chalk.yellow,
    'ready-to-merge': chalk.green,
    'blocked': chalk.red,
    'completed': chalk.green,
  };
  const colorFn = colors[stage] || chalk.white;
  return colorFn(`[${stage}]`);
}
