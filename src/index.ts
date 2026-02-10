import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { prCommand, type PrCommandOptions } from './commands/pr.js';
import { prStatusCommand } from './commands/pr-status.js';
import { ciStatusCommand } from './commands/ci-status.js';
import { ciFailureCommand } from './commands/ci-failure.js';
import { mergeCommand } from './commands/merge.js';
import { initCommand } from './commands/init.js';
import { prUpdateCommand, type PrUpdateOptions } from './commands/pr-update.js';
import { ticketCommand, type TicketCommandOptions } from './commands/ticket.js';
import { commentCommand, type CommentCommandOptions } from './commands/ticket-comment.js';
import { reviewCommand, type ReviewCommandOptions } from './commands/review.js';
import { tasksCommand, type TasksCommandOptions } from './commands/tasks.js';
import { ticketUpdateCommand, type TicketUpdateOptions } from './commands/ticket-update.js';
import { subtasksCommand, type SubtasksCommandOptions } from './commands/subtasks.js';
import { prReviewCommand, type PrReviewCommandOptions } from './commands/pr-review.js';
import { prReadyCommand, type PrReadyCommandOptions } from './commands/pr-ready.js';
import { prCommentCommand, type PrCommentCommandOptions } from './commands/pr-comment.js';
import { prPushCommand, type PrPushCommandOptions } from './commands/pr-push.js';
import { contextCommand, type ContextCommandOptions } from './commands/context.js';
import { cleanupCommand } from './commands/cleanup.js';
import { nextCommand } from './commands/next.js';
import { ticketCreateCommand, type TicketCreateOptions } from './commands/ticket-create.js';
import { validateCommand, type ValidateCommandOptions } from './commands/validate.js';
import { agentCommand, type AgentCommandOptions } from './commands/agent.js';
import {
  worktreeAddCommand,
  worktreeListCommand,
  worktreeRemoveCommand,
  worktreeStatusCommand,
  worktreeUpdateStatusCommand,
  type WorktreeAddOptions,
  type WorktreeListOptions,
  type WorktreeRemoveOptions,
  type WorktreeStatusOptions,
  type WorktreeUpdateStatusOptions,
} from './commands/worktree.js';
import { withGracefulExit } from './utils/exit.js';
import { setDryRun } from './utils/dry-run.js';

const program = new Command();

program
  .name('workon')
  .description('Development CLI for ClickUp + GitHub')
  .version('1.0.0')
  .enablePositionalOptions();

program
  .command('start')
  .description('Start work on a ticket (existing or new)')
  .argument('[ticket-id]', 'Optional ticket ID to start from')
  .option('-y, --yes', 'Skip confirmation prompts (accepts safe defaults)')
  .option('--cwd <path>', 'Run in a different directory (for multi-repo workflows)')
  .option('--worktree', 'Create a worktree instead of checking out a branch')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((ticketId: string | undefined, opts: { yes?: boolean; cwd?: string; worktree?: boolean; dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    if (opts.worktree && ticketId) {
      return worktreeAddCommand(ticketId, { yes: opts.yes });
    }
    return startCommand(ticketId, { yes: opts.yes, cwd: opts.cwd });
  }));

program
  .command('pr')
  .description('Create a pull request')
  .option('--draft', 'Create as draft PR')
  .option('--title <title>', 'PR title')
  .option('--summary <text>', 'Summary section, use "-" for stdin')
  .option('--ticket <id>', 'ClickUp ticket ID')
  .option('--description <text>', 'Description section, use "-" for stdin')
  .option('--testing <text>', 'Testing section, use "-" for stdin')
  .option('--base <branch>', 'Base branch for PR (auto-detected if not specified)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((options: PrCommandOptions & { dryRun?: boolean }) => {
    if (options.dryRun) setDryRun(true);
    return prCommand(options);
  }));

program
  .command('pr-update')
  .description('Update an existing PR')
  .argument('[pr-number]', 'PR number (defaults to current branch)')
  .option('--title <title>', 'Update PR title')
  .option('--summary <text>', 'Update summary section, use "-" for stdin')
  .option('--ticket <id>', 'Update ticket link')
  .option('--description <text>', 'Update description section, use "-" for stdin')
  .option('--testing <text>', 'Update testing section, use "-" for stdin')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((prNumber: string | undefined, options: PrUpdateOptions & { dryRun?: boolean }) => {
    if (options.dryRun) setDryRun(true);
    return prUpdateCommand(prNumber, options);
  }));

program
  .command('pr-status')
  .description('Check PR status (CI, approvals)')
  .argument('[pr-number]', 'PR number (defaults to current branch)')
  .action(withGracefulExit(async (prNumber?: string) => {
    await prStatusCommand(prNumber);
  }));

program
  .command('pr-review')
  .description('Show PR review comments and feedback')
  .argument('[pr-number]', 'PR number (defaults to current branch)')
  .option('--json', 'Output as JSON')
  .action(withGracefulExit((prNumber: string | undefined, options: PrReviewCommandOptions) => {
    return prReviewCommand(prNumber, options);
  }));

program
  .command('pr-ready')
  .description('Mark a draft PR as ready for review')
  .argument('[pr-number]', 'PR number (defaults to current branch)')
  .option('-y, --yes', 'Skip confirmation')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((prNumber: string | undefined, opts: PrReadyCommandOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return prReadyCommand(prNumber, { yes: opts.yes });
  }));

program
  .command('pr-comment')
  .description('Reply to a PR review comment')
  .argument('[pr-number]', 'PR number (defaults to current branch)')
  .option('--reply-to <comment-id>', 'Comment ID to reply to')
  .option('--body <text>', 'Reply body (or use stdin with "-")')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((prNumber: string | undefined, opts: PrCommentCommandOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return prCommentCommand(prNumber, { replyTo: opts.replyTo, body: opts.body });
  }));

program
  .command('pr-push')
  .description('Push changes and re-request review')
  .argument('[pr-number]', 'PR number (defaults to current branch)')
  .option('-y, --yes', 'Skip confirmation')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((prNumber: string | undefined, opts: PrPushCommandOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return prPushCommand(prNumber, { yes: opts.yes });
  }));

program
  .command('ci-status')
  .description('Check CircleCI status for a branch')
  .argument('[branch]', 'Branch name (defaults to current branch)')
  .action(withGracefulExit(async (branch?: string) => {
    await ciStatusCommand(branch);
  }));

program
  .command('ci-failure')
  .description('Get detailed output from a failed CI job')
  .argument('[job-number]', 'Job number (defaults to first failed job on current branch)')
  .option('--branch <branch>', 'Branch to check for failed jobs')
  .action(withGracefulExit(async (jobNumber?: string, options?: { branch?: string }) => {
    await ciFailureCommand(jobNumber, options?.branch);
  }));

program
  .command('merge')
  .description('Post /merge comment to trigger merge automation')
  .argument('[pr-number]', 'PR number (defaults to current branch)')
  .option('-y, --yes', 'Skip confirmation prompt (accepts safe defaults)')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((prNumber: string | undefined, opts: { yes?: boolean; dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return mergeCommand(prNumber, { yes: opts.yes });
  }));

program
  .command('init')
  .description('Initialize configuration file')
  .action(withGracefulExit(initCommand));

program
  .command('ticket')
  .description('Get ticket info from ClickUp (for current branch or specified ticket)')
  .argument('[ticket-id]', 'Ticket ID (defaults to extracting from current branch)')
  .option('--json', 'Output as JSON (includes comments and subtasks)')
  .option('--markdown', 'Output as markdown with YAML frontmatter')
  .action(withGracefulExit((ticketId: string | undefined, options: TicketCommandOptions) => {
    return ticketCommand(ticketId, options);
  }));

program
  .command('review')
  .description('Review ticket description and optionally push updates to ClickUp')
  .argument('[ticket-id]', 'Ticket ID (defaults to extracting from current branch)')
  .option('--deep', 'AI-assisted ticket analysis and improvement')
  .option('--hierarchy', 'Use parent/sibling context for cross-platform review')
  .option('--reviewer <model>', 'Secondary review model: codex or gemini (requires --deep)')
  .option('-y, --yes', 'Skip confirmation prompts (accepts all findings, auto-accepts improvement)')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((ticketId: string | undefined, opts: ReviewCommandOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return reviewCommand(ticketId, { deep: opts.deep, hierarchy: opts.hierarchy, reviewer: opts.reviewer, yes: opts.yes });
  }));

program
  .command('ticket-comment')
  .description('Add a comment to a ClickUp ticket')
  .argument('[comment]', 'Comment text (or pipe via stdin)')
  .option('--ticket <id>', 'Target ticket ID (defaults to extracting from current branch)')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((comment: string | undefined, opts: CommentCommandOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return commentCommand(comment, { ticket: opts.ticket });
  }));

program
  .command('tasks')
  .description('List tasks assigned to you')
  .option('--json', 'Output as JSON')
  .option('--limit <n>', 'Maximum number of tasks to show', '20')
  .option('--status <statuses...>', 'Filter by status (e.g. --status "in progress" "on deck")')
  .action(withGracefulExit((options: TasksCommandOptions) => {
    return tasksCommand(options);
  }));

program
  .command('ticket-update')
  .description('Update a ClickUp ticket (status, description, name)')
  .argument('[ticket-id]', 'Ticket ID (defaults to extracting from current branch)')
  .option('--status <status>', 'Set ticket status')
  .option('--description <text>', 'Set description, use "-" for stdin')
  .option('--name <name>', 'Set ticket name')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((ticketId: string | undefined, opts: TicketUpdateOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return ticketUpdateCommand(ticketId, opts);
  }));

program
  .command('subtasks')
  .description('List subtasks for a ClickUp ticket')
  .argument('[ticket-id]', 'Parent ticket ID (defaults to current branch)')
  .option('--json', 'Output as JSON')
  .action(withGracefulExit((ticketId: string | undefined, options: SubtasksCommandOptions) => {
    return subtasksCommand(ticketId, options);
  }));

program
  .command('context')
  .description('Show workflow context: ticket, git, PR, CI, and recommended next action')
  .option('--json', 'Output as JSON (useful for agent consumption)')
  .action(withGracefulExit((options: ContextCommandOptions) => {
    return contextCommand(options);
  }));

program
  .command('cleanup')
  .description('Switch to base branch, pull, and delete current feature branch')
  .option('-y, --yes', 'Skip confirmation')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((opts: { yes?: boolean; dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return cleanupCommand({ yes: opts.yes });
  }));

program
  .command('next')
  .description('Pick your next task from assigned tickets and start working')
  .option('--limit <n>', 'Maximum number of tasks to show', '10')
  .action(withGracefulExit((options: { limit?: string }) => {
    return nextCommand(options);
  }));

program
  .command('ticket-create')
  .description('Create a new ClickUp ticket (non-interactive)')
  .requiredOption('--name <title>', 'Ticket title')
  .option('--description <text>', 'Ticket description (use "-" for stdin)')
  .option('--list <id>', 'ClickUp list ID (defaults to first list in default workspace)')
  .option('--status <status>', 'Initial status (defaults to config default)')
  .option('--start', 'Immediately start working on the created ticket')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((opts: TicketCreateOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return ticketCreateCommand(opts);
  }));

program
  .command('validate')
  .description('Validate ticket readiness (description, AC, platform, assignee)')
  .argument('[ticket-id]', 'Ticket ID (defaults to extracting from current branch)')
  .option('--json', 'Output as JSON')
  .option('--comment', 'Post missing requirements as a comment on the ticket')
  .option('--deep', 'Run AI-powered semantic analysis')
  .option('--hierarchy', 'Cross-validate parent/subtask hierarchy (coverage, contracts, ordering)')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((ticketId: string | undefined, options: ValidateCommandOptions & { dryRun?: boolean }) => {
    if (options.dryRun) setDryRun(true);
    return validateCommand(ticketId, options).then(() => {});
  }));

program
  .command('agent')
  .description('Start agent polling mode — watches for new tasks, PR reviews, CI failures')
  .option('--interval <seconds>', 'Polling interval in seconds (default: 300)')
  .option('--once', 'Run a single poll and exit')
  .option('--status <statuses...>', 'Statuses to watch (default: "on deck" "ready for eng" "open" "to do")')
  .action(withGracefulExit((options: AgentCommandOptions) => {
    return agentCommand(options);
  }));

const worktree = program
  .command('worktree')
  .description('Manage git worktrees for background development');

worktree
  .command('add')
  .description('Create a worktree for background agent work on a ticket')
  .argument('<ticket-id>', 'ClickUp ticket ID')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((ticketId: string, opts: WorktreeAddOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return worktreeAddCommand(ticketId, { yes: opts.yes });
  }));

worktree
  .command('list')
  .description('List all worktrees with pipeline status')
  .option('--json', 'Output as JSON')
  .action(withGracefulExit(async (opts: WorktreeListOptions) => {
    worktreeListCommand(opts);
  }));

worktree
  .command('remove')
  .description('Remove a worktree and its branch')
  .argument('<ticket-id>', 'ClickUp ticket ID')
  .option('-y, --yes', 'Skip confirmation')
  .option('--keep', 'Keep the branch after removing worktree')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit((ticketId: string, opts: WorktreeRemoveOptions & { dryRun?: boolean }) => {
    if (opts.dryRun) setDryRun(true);
    return worktreeRemoveCommand(ticketId, opts);
  }));

worktree
  .command('status')
  .description('Show detailed status of one or all worktrees')
  .argument('[ticket-id]', 'ClickUp ticket ID (omit for all)')
  .option('--json', 'Output as JSON')
  .action(withGracefulExit(async (ticketId: string | undefined, opts: WorktreeStatusOptions) => {
    worktreeStatusCommand(ticketId, opts);
  }));

worktree
  .command('update-status')
  .description('Update pipeline stage for current worktree (used by background agents)')
  .option('--stage <stage>', 'Pipeline stage')
  .option('--blocked <reason>', 'Reason for blocked state')
  .option('--pr-url <url>', 'PR URL')
  .option('--pr-number <n>', 'PR number')
  .action(withGracefulExit(async (opts: WorktreeUpdateStatusOptions) => {
    worktreeUpdateStatusCommand(opts);
  }));

// Default command: treat argument as ticket ID (shortcut for `workon start <id>`)
program
  .argument('[ticket-id]', 'Ticket ID (shortcut for `workon start <id>`)')
  .option('-y, --yes', 'Skip confirmation prompts (accepts safe defaults)')
  .option('--dry-run', 'Show what would be done without executing')
  .action(withGracefulExit(async (ticketId: string | undefined, opts: { yes?: boolean; dryRun?: boolean }) => {
    if (ticketId) {
      if (opts.dryRun) setDryRun(true);
      await startCommand(ticketId, { yes: opts.yes });
    }
  }));

program.parse();
