import chalk from 'chalk';
import { checkbox, confirm, select } from '@inquirer/prompts';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import {
  fetchEnrichedTicket,
  renderMarkdown,
  parseTicketMarkdown,
  writeTicketFile,
  getTicketFilePath,
} from '../utils/ticket-file.js';
import { createSpinner, showSuccess, showWarning, showBox, editExternally } from '../utils/ui.js';
import { fetchHierarchyTree, buildHierarchyContext } from '../utils/hierarchy.js';
import * as git from '../services/git.js';
import * as claude from '../services/claude.js';
import { parseSemanticFindings } from './validate.js';
import type { SemanticFinding, HierarchyTree } from '../types.js';

const ANALYSIS_PROMPT = `You are a senior engineering manager reviewing a ticket before it is assigned.
Analyze for quality issues that could cause confusion, wasted effort, or incorrect implementation.

Evaluate these 5 dimensions:
- clarity: Is the description clear and unambiguous?
- acceptance-criteria: Are ACs specific, testable, and complete?
- missing-context: Is critical context missing (error states, edge cases, dependencies)?
- ambiguity: Are there terms or requirements that could be interpreted multiple ways?
- scope: Is the scope well-defined, or could it creep?

Return a JSON array of objects with these fields:
- category: one of "clarity", "acceptance-criteria", "missing-context", "ambiguity", "scope"
- severity: "warning" for significant issues, "suggestion" for nice-to-haves
- message: brief description of the issue
- recommendation: specific actionable improvement

Return an empty array [] if the ticket is excellent and needs no improvements.
Return ONLY the JSON array, no other text.`;

const IMPROVE_PROMPT = `You are improving a ticket description based on specific findings.
Incorporate the accepted improvements while preserving the original author's voice and intent.
Keep the description concise. Ensure every acceptance criterion is specific and testable.

FINDINGS TO ADDRESS:
{findings}

Return ONLY the improved description, no preamble or explanation.`;

const HIERARCHY_IMPROVE_PROMPT = `You are improving a subtask description for a cross-platform feature.
Use the HIERARCHY CONTEXT to:
- Reference exact API endpoints, setting names, and values from sibling subtasks
- Ensure ACs are specific, testable, and aligned with parent requirements
- Add technical details inferable from sibling descriptions
- Preserve the original author's voice and intent

HIERARCHY CONTEXT:
{hierarchy_context}

FINDINGS TO ADDRESS:
{findings}

Return ONLY the improved description, no preamble or explanation.`;

const HIERARCHY_ANALYSIS_PROMPT = `You are a senior engineering manager reviewing a cross-platform feature.
You are given a PARENT ticket and its platform SUBTASKS.

Evaluate these dimensions:

1. **coverage-gap**: Do subtask ACs collectively satisfy ALL parent ACs?
2. **contract-mismatch**: Shared technical contracts must be referenced consistently.
3. **dependency-ordering**: Which subtasks must complete before others?
4. **thin-subtask**: Flag subtasks significantly less detailed than siblings.
5. Standard issues framed in hierarchy context.

Return a JSON array with fields:
- category: one of "coverage-gap", "contract-mismatch", "dependency-ordering",
  "thin-subtask", "clarity", "acceptance-criteria", "missing-context", "ambiguity", "scope"
- severity: "warning" for blocking issues, "suggestion" for improvements
- message: brief description
- recommendation: specific actionable fix
- ticketId: the ticket ID this applies to
- ticketName: the ticket name

Return [] if hierarchy is well-structured. Return ONLY the JSON array.`;

const SECONDARY_REVIEW_PROMPT = `You are a fresh pair of eyes reviewing a ticket that has already been improved.
Look for blind spots: unstated assumptions, edge cases, missing error handling,
integration concerns, or scope creep risks that the original author may have missed.

Return a JSON array of objects with these fields:
- category: one of "clarity", "acceptance-criteria", "missing-context", "ambiguity", "scope"
- severity: "warning" for significant issues, "suggestion" for nice-to-haves
- message: brief description of the issue
- recommendation: specific actionable improvement

Return an empty array [] if the ticket looks solid.
Return ONLY the JSON array, no other text.`;

export interface ReviewCommandOptions {
  deep?: boolean;
  reviewer?: string;
  yes?: boolean;
  hierarchy?: boolean;
}

export async function reviewCommand(ticketIdArg?: string, options: ReviewCommandOptions = {}): Promise<void> {
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

  // 1. Fetch enriched ticket data
  const spinner = createSpinner('Fetching ticket...').start();

  let enriched;
  try {
    enriched = await fetchEnrichedTicket(clickup, ticketId);
    spinner.succeed(`Found: ${enriched.task.name}`);
  } catch (error) {
    spinner.fail('Failed to fetch ticket');
    console.error(chalk.red(error));
    process.exit(1);
  }

  // Fetch hierarchy tree if --hierarchy
  let tree: HierarchyTree | null = null;
  if (options.hierarchy) {
    const hierarchySpinner = createSpinner('Fetching hierarchy...').start();
    try {
      tree = await fetchHierarchyTree(clickup, enriched.task);
      if (tree) {
        hierarchySpinner.succeed(`Hierarchy: ${tree.parent.name} + ${tree.subtasks.length} subtask(s)`);
      } else {
        hierarchySpinner.stop();
      }
    } catch {
      hierarchySpinner.stop();
    }
  }

  // If hierarchy + deep on a parent with subtasks, run parent-level review
  if (options.hierarchy && options.deep && tree && tree.parent.id === enriched.task.id) {
    await parentLevelReviewFlow(tree, clickup, options);
    return;
  }

  // 2. Render and write markdown file
  const markdown = renderMarkdown(enriched);
  writeTicketFile(ticketId, markdown);

  const filePath = getTicketFilePath(ticketId);
  console.log(`\n  ${chalk.dim('File:')} ${chalk.cyan(filePath)}\n`);

  // 3. Show current description
  const originalDescription = enriched.task.text_content || enriched.task.description || '';
  if (originalDescription.trim()) {
    showBox(originalDescription, 'Current Description');
  } else {
    console.log(chalk.yellow('  (No description)\n'));
  }

  // If --deep, run the AI-assisted flow
  if (options.deep) {
    const improvedDescription = await deepReviewFlow(
      enriched.task.name,
      originalDescription,
      filePath,
      options,
      tree,
    );

    if (improvedDescription !== null && improvedDescription !== originalDescription.trim()) {
      // Push to ClickUp
      const shouldPush = options.yes || await confirm({
        message: 'Push improved description to ClickUp?',
        default: false,
      });

      if (shouldPush) {
        const updateSpinner = createSpinner('Updating ticket...').start();
        try {
          await clickup.updateTask(ticketId, {
            markdown_description: improvedDescription,
          });
          updateSpinner.succeed('Ticket updated in ClickUp');
        } catch (error) {
          updateSpinner.fail('Failed to update ticket');
          console.error(chalk.red(error));
        }
      }
    }

    showSuccess(`Ticket file saved: ${filePath}`);
    return;
  }

  // Standard (non-deep) flow: offer to edit
  const wantEdit = await confirm({
    message: 'Edit ticket description?',
    default: true,
  });

  if (wantEdit) {
    const edited = await editExternally(markdown, filePath);

    // 5. Parse and compare
    try {
      const parsed = parseTicketMarkdown(edited);
      const descriptionChanged = parsed.description !== originalDescription.trim();

      if (!descriptionChanged) {
        console.log(chalk.dim('\nNo changes to description.'));
        showSuccess(`Ticket file saved: ${filePath}`);
        return;
      }

      // Show what changed
      console.log(chalk.bold('\nUpdated description:'));
      showBox(parsed.description, 'New Description');

      // 6. Offer to push back to ClickUp
      const pushToClickUp = await confirm({
        message: 'Push updated description to ClickUp?',
        default: false,
      });

      if (pushToClickUp) {
        const updateSpinner = createSpinner('Updating ticket...').start();
        try {
          await clickup.updateTask(ticketId, {
            markdown_description: parsed.description,
          });
          updateSpinner.succeed('Ticket updated in ClickUp');
        } catch (error) {
          updateSpinner.fail('Failed to update ticket');
          console.error(chalk.red(error));
        }
      }
    } catch (error) {
      console.error(chalk.red('Failed to parse edited file:'), error);
      console.log(chalk.yellow(`Your edits are saved at: ${filePath}`));
      return;
    }
  }

  showSuccess(`Ticket file saved: ${filePath}`);
}

/**
 * Deep review flow: analyze → triage → improve → optional secondary review
 * Returns the final description or null if user kept original.
 * When hierarchy tree is available, uses hierarchy-aware prompts.
 */
async function deepReviewFlow(
  taskName: string,
  originalDescription: string,
  filePath: string,
  options: ReviewCommandOptions,
  tree?: HierarchyTree | null,
): Promise<string | null> {
  const description = originalDescription.trim();
  if (!description) {
    showWarning('No description to analyze');
    return null;
  }

  // Step 2: Semantic analysis
  if (!claude.isClaudeAvailable()) {
    showWarning('Claude CLI not available — cannot run deep analysis');
    return null;
  }

  const analysisSpinner = createSpinner('Analyzing ticket quality...').start();
  let findings: SemanticFinding[];

  try {
    // Build context with optional hierarchy information
    const hierarchyContext = tree ? buildHierarchyContext(tree) : '';
    const context = tree
      ? `# Reviewing: ${taskName}\n\n${description}\n\n---\n# HIERARCHY CONTEXT\n${hierarchyContext}`
      : `# ${taskName}\n\n${description}`;

    const raw = await claude.generateWithContext(ANALYSIS_PROMPT, context);
    findings = parseSemanticFindings(raw);
    analysisSpinner.succeed('Analysis complete');
  } catch (error) {
    analysisSpinner.fail('Analysis failed');
    showWarning(`Skipping deep analysis: ${error instanceof Error ? error.message : error}`);
    return null;
  }

  if (findings.length === 0) {
    showSuccess('Ticket looks great — no issues found');
    return null;
  }

  // Step 3: Triage findings
  let acceptedFindings: SemanticFinding[];

  if (options.yes) {
    // Non-interactive: accept all findings
    acceptedFindings = findings;
    console.log(chalk.bold(`\nAccepting all ${findings.length} findings (--yes)\n`));
  } else {
    acceptedFindings = await triageFindings(findings);
  }

  if (acceptedFindings.length === 0) {
    console.log(chalk.dim('\nNo findings accepted — keeping original description.'));
    return null;
  }

  // Step 4: Generate improved description
  const improveSpinner = createSpinner('Generating improved description...').start();
  let improvedDescription: string;

  try {
    const findingsText = acceptedFindings
      .map(f => `- [${f.category}] ${f.message}: ${f.recommendation}`)
      .join('\n');

    // Use hierarchy-aware prompt when context available
    let prompt: string;
    if (tree) {
      const hierarchyContext = buildHierarchyContext(tree);
      prompt = HIERARCHY_IMPROVE_PROMPT
        .replace('{hierarchy_context}', hierarchyContext)
        .replace('{findings}', findingsText);
    } else {
      prompt = IMPROVE_PROMPT.replace('{findings}', findingsText);
    }

    improvedDescription = await claude.generateWithContext(prompt, description);
    improveSpinner.succeed('Improved description generated');
  } catch (error) {
    improveSpinner.fail('Failed to generate improvement');
    showWarning(`Skipping improvement: ${error instanceof Error ? error.message : error}`);
    return null;
  }

  // Interactive edit loop
  let finalDescription = improvedDescription;

  if (options.yes) {
    console.log('');
    showBox(finalDescription, 'Improved Description');
  } else {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.log('');
      showBox(finalDescription, 'Description');

      const action = await select({
        message: 'What would you like to do?',
        choices: [
          { value: 'accept', name: 'Accept this description' },
          { value: 'edit', name: 'Edit in editor' },
          { value: 'keep', name: 'Discard — keep original' },
        ],
      });

      if (action === 'keep') {
        return null;
      } else if (action === 'edit') {
        finalDescription = await editExternally(finalDescription, filePath);
        // Loop back to show the updated version
        continue;
      } else {
        break;
      }
    }
  }

  // Step 5: Optional secondary review
  if (options.reviewer) {
    const reviewerDescription = await runSecondaryReview(
      options.reviewer,
      taskName,
      finalDescription,
      filePath,
      options.yes,
    );
    if (reviewerDescription !== null) {
      finalDescription = reviewerDescription;
    }
  }

  return finalDescription;
}

/**
 * Parent-level review: iterate subtasks with hierarchy context,
 * allowing user to improve each one individually.
 */
async function parentLevelReviewFlow(
  tree: HierarchyTree,
  clickup: ReturnType<typeof createClickUpClient>,
  options: ReviewCommandOptions,
): Promise<void> {
  // Show summary
  console.log(chalk.bold(`\nParent: ${tree.parent.name} (${tree.parent.id})`));
  console.log(chalk.dim(`Subtasks: ${tree.subtasks.length}`));
  for (const sub of tree.subtasks) {
    const desc = (sub.text_content || sub.description || '').trim();
    const length = desc.length;
    console.log(`  - ${sub.id} ${sub.name} (${length} chars)`);
  }
  console.log('');

  // Run hierarchy analysis
  if (!claude.isClaudeAvailable()) {
    showWarning('Claude CLI not available — cannot run hierarchy analysis');
    return;
  }

  const analysisSpinner = createSpinner('Running hierarchy analysis...').start();
  let allFindings: SemanticFinding[];
  try {
    const context = buildHierarchyContext(tree);
    const raw = await claude.generateWithContext(HIERARCHY_ANALYSIS_PROMPT, context);
    allFindings = parseSemanticFindings(raw);
    analysisSpinner.succeed('Hierarchy analysis complete');
  } catch (error) {
    analysisSpinner.fail('Hierarchy analysis failed');
    showWarning(`${error instanceof Error ? error.message : error}`);
    return;
  }

  if (allFindings.length === 0) {
    showSuccess('Hierarchy looks great — no issues found');
    return;
  }

  // Show all findings
  console.log(chalk.bold(`\nHierarchy findings (${allFindings.length}):\n`));
  for (const f of allFindings) {
    const icon = f.severity === 'warning' ? chalk.yellow('!') : chalk.dim('~');
    const severityColor = f.severity === 'warning' ? chalk.yellow : chalk.dim;
    const target = f.ticketId ? chalk.dim(` (${f.ticketId})`) : '';
    console.log(`  ${icon} ${severityColor(`[${f.category}]`)} ${f.message}${target}`);
    console.log(chalk.dim(`    → ${f.recommendation}`));
  }

  // Group findings by subtask
  const findingsBySubtask = new Map<string, SemanticFinding[]>();
  for (const f of allFindings) {
    if (f.ticketId) {
      const existing = findingsBySubtask.get(f.ticketId) ?? [];
      existing.push(f);
      findingsBySubtask.set(f.ticketId, existing);
    }
  }

  // For each subtask with findings, offer to improve
  for (const sub of tree.subtasks) {
    const subFindings = findingsBySubtask.get(sub.id);
    if (!subFindings || subFindings.length === 0) continue;

    console.log(chalk.bold(`\n--- ${sub.name} (${sub.id}) ---`));
    console.log(`${subFindings.length} finding(s)\n`);

    const shouldImprove = options.yes || await confirm({
      message: `Improve this subtask?`,
      default: true,
    });

    if (!shouldImprove) continue;

    const originalDescription = (sub.text_content || sub.description || '').trim();
    if (!originalDescription) {
      showWarning('No description to improve — skipping');
      continue;
    }

    const filePath = getTicketFilePath(sub.id);
    const improved = await deepReviewFlow(
      sub.name,
      originalDescription,
      filePath,
      options,
      tree,
    );

    if (improved !== null && improved !== originalDescription) {
      const shouldPush = options.yes || await confirm({
        message: `Push improved description to ClickUp for ${sub.id}?`,
        default: false,
      });

      if (shouldPush) {
        const updateSpinner = createSpinner(`Updating ${sub.id}...`).start();
        try {
          await clickup.updateTask(sub.id, { markdown_description: improved });
          updateSpinner.succeed(`Updated ${sub.id} in ClickUp`);
        } catch (error) {
          updateSpinner.fail(`Failed to update ${sub.id}`);
          console.error(chalk.red(error));
        }
      }
    }
  }

  showSuccess('Parent-level review complete');
}

async function triageFindings(findings: SemanticFinding[]): Promise<SemanticFinding[]> {
  const icon = (f: SemanticFinding) => f.severity === 'warning' ? '!' : '~';
  const choices = findings.map((f, i) => ({
    value: i,
    name: `${icon(f)} [${f.category}] ${f.message}`,
    description: f.recommendation,
    checked: f.severity === 'warning', // pre-check warnings, leave suggestions unchecked
  }));

  const selected = await checkbox({
    message: `Select findings to address (${findings.length} found):`,
    choices,
  });

  return selected.map(i => findings[i]);
}

async function runSecondaryReview(
  reviewerName: string,
  taskName: string,
  description: string,
  filePath: string,
  nonInteractive = false,
): Promise<string | null> {
  let generateFn: (prompt: string, context?: string) => Promise<string>;
  let isAvailable: () => boolean;

  if (reviewerName === 'codex') {
    const externalModels = await import('../services/external-models.js');
    generateFn = (prompt: string) => externalModels.codexGenerate(prompt + '\n\n' + description);
    isAvailable = externalModels.isCodexAvailable;
  } else if (reviewerName === 'gemini') {
    const externalModels = await import('../services/external-models.js');
    generateFn = (prompt: string, context?: string) => externalModels.geminiGenerate(prompt, context);
    isAvailable = externalModels.isGeminiAvailable;
  } else {
    showWarning(`Unknown reviewer "${reviewerName}" — supported: codex, gemini`);
    return null;
  }

  if (!isAvailable()) {
    showWarning(`${reviewerName} CLI not available — skipping secondary review`);
    return null;
  }

  const spinner = createSpinner(`Running secondary review (${reviewerName})...`).start();

  try {
    const context = `# ${taskName}\n\n${description}`;
    const raw = reviewerName === 'gemini'
      ? await generateFn(SECONDARY_REVIEW_PROMPT, context)
      : await generateFn(SECONDARY_REVIEW_PROMPT + '\n\nTICKET:\n' + context);
    const findings = parseSemanticFindings(raw);
    spinner.succeed(`Secondary review complete (${reviewerName})`);

    if (findings.length === 0) {
      showSuccess('Secondary reviewer found no additional issues');
      return null;
    }

    // Show reviewer findings
    console.log(chalk.bold(`\n${reviewerName} found ${findings.length} additional finding${findings.length !== 1 ? 's' : ''}:\n`));
    for (const f of findings) {
      const severityColor = f.severity === 'warning' ? chalk.yellow : chalk.dim;
      const icon = f.severity === 'warning' ? chalk.yellow('!') : chalk.dim('~');
      console.log(`  ${icon} ${severityColor(`[${f.category}]`)} ${f.message}`);
      console.log(chalk.dim(`    → ${f.recommendation}`));
      console.log('');
    }

    if (nonInteractive) {
      return null; // In non-interactive mode, just show findings
    }

    // Let user address remaining issues via editor
    const wantEdit = await confirm({
      message: 'Open editor to address reviewer findings?',
      default: true,
    });

    if (wantEdit) {
      return await editExternally(description, filePath);
    }

    return null;
  } catch (error) {
    spinner.fail(`Secondary review failed (${reviewerName})`);
    showWarning(`Skipping secondary review: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
