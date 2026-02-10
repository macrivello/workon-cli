import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { createClickUpClient } from '../services/clickup.js';
import { extractTicketIdFromBranch } from '../utils/branch.js';
import { getPlatform, getRepoForTask } from '../utils/platform.js';
import { showSuccess, showWarning, createSpinner } from '../utils/ui.js';
import { fetchHierarchyTree, buildHierarchyContext, inferDependencyOrder } from '../utils/hierarchy.js';
import * as git from '../services/git.js';
import * as claude from '../services/claude.js';
import type { ClickUpTask, SemanticFinding, ValidateResult, HierarchyTree } from '../types.js';

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

const HIERARCHY_ANALYSIS_PROMPT = `You are a senior engineering manager reviewing a cross-platform feature.
You are given a PARENT ticket and its platform SUBTASKS.

Evaluate these dimensions:

1. **coverage-gap**: Do subtask ACs collectively satisfy ALL parent ACs?
   Identify any parent requirement that no subtask addresses.

2. **contract-mismatch**: Shared technical contracts (API endpoints, setting names,
   field names, response formats) must be referenced consistently across subtasks.
   If one subtask defines a setting or API endpoint but the consuming subtask doesn't
   reference the exact key or endpoint, flag it.

3. **dependency-ordering**: Which subtasks must complete before others?
   (e.g., backend creates API → mobile reads it). Flag undocumented dependencies.

4. **thin-subtask**: Flag subtasks whose description/ACs are significantly less
   detailed than their siblings or insufficient for the complexity implied.

5. Standard issues (clarity, acceptance-criteria, missing-context, ambiguity, scope)
   framed in hierarchy context — e.g., "This subtask doesn't specify the setting key,
   but the sibling subtask defines it."

Return a JSON array with fields:
- category: one of "coverage-gap", "contract-mismatch", "dependency-ordering",
  "thin-subtask", "clarity", "acceptance-criteria", "missing-context", "ambiguity", "scope"
- severity: "warning" for blocking issues, "suggestion" for improvements
- message: brief description
- recommendation: specific actionable fix
- ticketId: the ticket ID this applies to (parent ID for coverage gaps)
- ticketName: the ticket name

Return [] if hierarchy is well-structured. Return ONLY the JSON array.`;

export { type ValidateResult } from '../types.js';

export interface ValidateCommandOptions {
  json?: boolean;
  comment?: boolean;
  deep?: boolean;
  hierarchy?: boolean;
}

export async function validateCommand(ticketIdArg?: string, options: ValidateCommandOptions = {}): Promise<ValidateResult | null> {
  const config = loadConfig();
  const clickup = createClickUpClient(config.clickup.apiToken, config.clickup.workspaceId);

  let ticketId = ticketIdArg;

  if (!ticketId) {
    if (!git.isGitRepo()) {
      console.error(chalk.red('Not in a git repository and no ticket ID provided.'));
      process.exit(1);
    }
    const branch = git.currentBranch();
    ticketId = extractTicketIdFromBranch(branch) ?? undefined;
    if (!ticketId) {
      console.error(chalk.red('Could not extract ticket ID from branch name.'));
      process.exit(1);
    }
  }

  const spinner = options.json ? null : createSpinner('Validating ticket...').start();

  try {
    const task = await clickup.getTask(ticketId);

    // Detect multi-platform parents: check for subtasks
    const subtasks = await clickup.getTaskSubtasks(ticketId);

    if (spinner) spinner.stop();

    const result = validateTicket(task, config, subtasks.length > 0);

    // Run semantic analysis and hierarchy fetch in parallel when both are needed
    const wantHierarchy = options.hierarchy;

    // Launch parallel work
    const semanticPromise = options.deep
      ? runSemanticValidation(task, options.json)
      : Promise.resolve([] as SemanticFinding[]);

    const hierarchySpinner = wantHierarchy && !options.json
      ? createSpinner('Fetching hierarchy...').start()
      : null;
    const hierarchyPromise = wantHierarchy
      ? fetchHierarchyTree(clickup, task)
      : Promise.resolve(null);

    // Await both concurrently
    const [semanticFindings, tree] = await Promise.all([semanticPromise, hierarchyPromise]);

    // Apply semantic findings
    if (semanticFindings.length > 0) {
      result.semanticFindings = semanticFindings;
      for (const f of semanticFindings) {
        result.warnings.push(`[${f.category}] ${f.message}`);
      }
    }

    // Apply hierarchy results
    if (tree) {
      if (hierarchySpinner) hierarchySpinner.succeed('Hierarchy loaded');

      // Validate each subtask structurally
      result.subtaskResults = tree.subtasks.map(sub => validateTicket(sub, config));

      // Compute dependency order
      result.dependencyOrder = inferDependencyOrder(tree);

      // Run AI hierarchy analysis
      if (options.deep || options.hierarchy) {
        const hierarchyFindings = await runHierarchyValidation(tree, options.json);
        if (hierarchyFindings.length > 0) {
          result.hierarchyFindings = hierarchyFindings;
          for (const f of hierarchyFindings) {
            if (f.severity === 'warning') {
              result.warnings.push(`[${f.category}] ${f.message}`);
            }
          }
        }
      }
    } else {
      if (hierarchySpinner) hierarchySpinner.stop();
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      renderResult(result);
    }

    // Post comment on ticket with missing requirements
    if (options.comment) {
      await postValidationComments(ticketId, result, clickup);
    }

    return result;
  } catch (error) {
    if (spinner) spinner.fail('Failed to validate ticket');
    console.error(chalk.red(error));
    return null;
  }
}

async function runSemanticValidation(task: ClickUpTask, silent = false): Promise<SemanticFinding[]> {
  const description = (task.text_content || task.description || '').trim();
  if (!description) return [];

  if (!claude.isClaudeAvailable()) {
    if (!silent) showWarning('Claude CLI not available — skipping semantic analysis');
    return [];
  }

  const spinner = silent ? null : createSpinner('Running semantic analysis...').start();

  try {
    const context = `# ${task.name}\n\n${description}`;
    const raw = await claude.generateWithContext(ANALYSIS_PROMPT, context);
    if (spinner) spinner.succeed('Semantic analysis complete');
    return parseSemanticFindings(raw);
  } catch (error) {
    if (spinner) spinner.fail('Semantic analysis failed');
    if (!silent) showWarning(`Semantic analysis skipped: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

async function runHierarchyValidation(tree: HierarchyTree, silent = false): Promise<SemanticFinding[]> {
  if (!claude.isClaudeAvailable()) {
    if (!silent) showWarning('Claude CLI not available — skipping hierarchy analysis');
    return [];
  }

  const spinner = silent ? null : createSpinner('Running hierarchy analysis...').start();

  try {
    const context = buildHierarchyContext(tree);
    const raw = await claude.generateWithContext(HIERARCHY_ANALYSIS_PROMPT, context);
    if (spinner) spinner.succeed('Hierarchy analysis complete');
    return parseSemanticFindings(raw);
  } catch (error) {
    if (spinner) spinner.fail('Hierarchy analysis failed');
    if (!silent) showWarning(`Hierarchy analysis skipped: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/** Max length for recommendation text posted to ClickUp comments */
const MAX_RECOMMENDATION_LENGTH = 5000;

/**
 * Sanitize text for safe inclusion in ClickUp comments:
 * strip HTML tags, then truncate to max length.
 */
function sanitizeForComment(text: string): string {
  const stripped = text.replace(/<[^>]*>/g, '');
  if (stripped.length > MAX_RECOMMENDATION_LENGTH) {
    return stripped.slice(0, MAX_RECOMMENDATION_LENGTH) + '... (truncated)';
  }
  return stripped;
}

export function parseSemanticFindings(raw: string): SemanticFinding[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: return a single finding with the raw text (sanitized)
    return [{
      category: 'clarity',
      severity: 'suggestion',
      message: 'AI analysis returned non-structured feedback',
      recommendation: sanitizeForComment(raw.trim()),
    }];
  }

  if (!Array.isArray(parsed)) return [];

  const validCategories = new Set([
    'clarity', 'acceptance-criteria', 'missing-context', 'ambiguity', 'scope',
    'coverage-gap', 'contract-mismatch', 'dependency-ordering', 'thin-subtask',
  ]);
  const validSeverities = new Set(['warning', 'suggestion']);

  return parsed
    .filter((item: unknown): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null &&
      typeof (item as Record<string, unknown>).category === 'string' &&
      typeof (item as Record<string, unknown>).message === 'string' &&
      typeof (item as Record<string, unknown>).recommendation === 'string'
    )
    .map(item => {
      const finding: SemanticFinding = {
        category: validCategories.has(item.category as string) ? item.category as SemanticFinding['category'] : 'clarity',
        severity: validSeverities.has(item.severity as string) ? item.severity as SemanticFinding['severity'] : 'suggestion',
        message: String(item.message),
        recommendation: sanitizeForComment(String(item.recommendation)),
      };
      if (typeof item.ticketId === 'string') finding.ticketId = item.ticketId;
      if (typeof item.ticketName === 'string') finding.ticketName = item.ticketName;
      return finding;
    });
}

/**
 * Detect multi-platform by splitting on delimiters and checking if 2+ tokens
 * match known repo keys from config. This avoids false positives like "C++" or "iOS + 16.4".
 */
function isMultiPlatformValue(platform: string, repos: Record<string, { path: string }> | undefined): boolean {
  if (!repos) return false;
  const tokens = platform.split(/[&+\/]/).map(t => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length < 2) return false;
  const repoKeys = Object.keys(repos).map(k => k.toLowerCase());
  const matched = tokens.filter(token =>
    repoKeys.some(key => token.includes(key) || key.includes(token))
  );
  return matched.length >= 2;
}

export function validateTicket(task: ClickUpTask, config: ReturnType<typeof loadConfig>, hasSubtasks = false): ValidateResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  const description = (task.text_content || task.description || '').trim();
  const platform = getPlatform(task.custom_fields);
  const isMultiPlatform = hasSubtasks && !!platform && isMultiPlatformValue(platform, config.repos);

  // For multi-platform parents, don't resolve to a single repo
  const repoPath = isMultiPlatform ? null : getRepoForTask(task.custom_fields, config);

  // Required: description
  if (!description) {
    issues.push('Missing description — what needs to be done?');
  } else if (description.length < 30) {
    warnings.push('Description is very short — may lack sufficient detail');
  }

  // Required: acceptance criteria (look for common patterns)
  const hasAC = /acceptance criteria|AC:|expected behavior|expected result|should\s/i.test(description);
  if (!hasAC && description.length > 0) {
    warnings.push('No acceptance criteria found — how will we verify this is done?');
  }

  // Required: platform field (for multi-repo routing)
  if (!platform) {
    issues.push('Missing Platform field — needed to determine which repo to work in');
  }

  // Multi-platform parent: warn to use subtasks
  if (isMultiPlatform) {
    warnings.push(`Multi-platform parent (${platform}) — validate and start subtasks individually via \`workon subtasks ${task.id}\``);
  }

  // Warning: repo not mapped (skip for multi-platform parents)
  if (platform && !repoPath && !isMultiPlatform) {
    warnings.push(`Platform "${platform}" is not mapped to a repo path in config. Add it to "repos" in config.`);
  }

  // Required: assignee
  if (!task.assignees || task.assignees.length === 0) {
    warnings.push('No assignee — who is responsible for this work?');
  }

  const ready = issues.length === 0;

  return {
    ticketId: task.id,
    name: task.name,
    ready,
    issues,
    warnings,
    platform,
    repoPath,
  };
}

function renderResult(result: ValidateResult): void {
  console.log(chalk.bold(`\n${result.name}`));
  console.log(chalk.dim(`Ticket: ${result.ticketId}`));
  if (result.platform) {
    console.log(`Platform: ${chalk.blue(result.platform)}${result.repoPath ? chalk.dim(` → ${result.repoPath}`) : ''}`);
  }
  console.log('');

  if (result.ready) {
    showSuccess('Ticket is ready for work');
  } else {
    showWarning('Ticket is NOT ready for work');
    console.log('');
    console.log(chalk.red('Blocking issues:'));
    for (const issue of result.issues) {
      console.log(chalk.red(`  - ${issue}`));
    }
  }

  // Show structural warnings (exclude semantic + hierarchy findings which have their own sections)
  const semanticPrefixes = new Set(
    (result.semanticFindings ?? []).map(f => `[${f.category}] ${f.message}`)
  );
  const hierarchyPrefixes = new Set(
    (result.hierarchyFindings ?? []).map(f => `[${f.category}] ${f.message}`)
  );
  const structuralWarnings = result.warnings.filter(w =>
    !semanticPrefixes.has(w) && !hierarchyPrefixes.has(w)
  );
  if (structuralWarnings.length > 0) {
    console.log('');
    console.log(chalk.yellow('Warnings:'));
    for (const warning of structuralWarnings) {
      console.log(chalk.yellow(`  - ${warning}`));
    }
  }

  // Render semantic findings
  if (result.semanticFindings && result.semanticFindings.length > 0) {
    console.log('');
    console.log(chalk.bold(`Semantic Analysis (${result.semanticFindings.length}):`));
    for (const finding of result.semanticFindings) {
      const severityColor = finding.severity === 'warning' ? chalk.yellow : chalk.dim;
      const icon = finding.severity === 'warning' ? chalk.yellow('!') : chalk.dim('~');
      console.log(`  ${icon} ${severityColor(`[${finding.category}]`)} ${finding.message}`);
      console.log(chalk.dim(`    → ${finding.recommendation}`));
    }
  }

  // Render subtask validation results
  if (result.subtaskResults && result.subtaskResults.length > 0) {
    console.log('');
    console.log(chalk.bold('Subtask Validation:'));
    for (const sub of result.subtaskResults) {
      const acCount = (sub.warnings.filter(w => !w.startsWith('['))).length === 0
        ? chalk.green('PASS')
        : chalk.yellow(`${sub.warnings.length} warning${sub.warnings.length !== 1 ? 's' : ''}`);
      const platformLabel = sub.platform ? ` [${sub.platform}]` : '';
      console.log(`  ${sub.ticketId}${platformLabel} ${sub.name} — ${acCount}`);
    }
  }

  // Render hierarchy findings
  if (result.hierarchyFindings && result.hierarchyFindings.length > 0) {
    console.log('');
    console.log(chalk.bold(`Hierarchy Analysis (${result.hierarchyFindings.length}):`));
    for (const finding of result.hierarchyFindings) {
      const severityColor = finding.severity === 'warning' ? chalk.yellow : chalk.dim;
      const icon = finding.severity === 'warning' ? chalk.yellow('!') : chalk.dim('~');
      console.log(`  ${icon} ${severityColor(`[${finding.category}]`)} ${finding.message}`);
      console.log(chalk.dim(`    → ${finding.recommendation}`));
      if (finding.ticketId) {
        console.log(chalk.dim(`    → Applies to: ${finding.ticketId}`));
      }
    }
  }

  // Render execution plan (tiers)
  if (result.dependencyOrder && result.dependencyOrder.length > 0) {
    console.log('');
    console.log(chalk.bold('Execution plan:'));
    const subtaskMap = new Map(
      (result.subtaskResults ?? []).map(s => [s.ticketId, s])
    );
    for (let i = 0; i < result.dependencyOrder.length; i++) {
      const tier = result.dependencyOrder[i];
      const labels = tier.map(id => {
        const sub = subtaskMap.get(id);
        const platformLabel = sub?.platform ? ` [${sub.platform}]` : '';
        const name = sub?.name ?? id;
        return `${id}${platformLabel} ${name}`;
      });
      const parallel = tier.length > 1 ? chalk.green(' (parallel)') : '';
      console.log(`  Tier ${i + 1}${parallel}:`);
      for (const label of labels) {
        console.log(`    - ${label}`);
      }
    }
  }

  console.log('');
}

async function postValidationComments(
  ticketId: string,
  result: ValidateResult,
  clickup: ReturnType<typeof createClickUpClient>,
): Promise<void> {
  const commentLines: string[] = [];

  if (result.issues.length > 0) {
    commentLines.push(
      'This ticket needs the following before work can begin:',
      '',
      ...result.issues.map(i => `- ${i}`),
    );
  }

  // Structural warnings only (exclude semantic/hierarchy that have their own sections)
  const semanticPrefixes = new Set(
    (result.semanticFindings ?? []).map(f => `[${f.category}] ${f.message}`)
  );
  const hierarchyPrefixes = new Set(
    (result.hierarchyFindings ?? []).map(f => `[${f.category}] ${f.message}`)
  );
  const structuralWarnings = result.warnings.filter(w =>
    !semanticPrefixes.has(w) && !hierarchyPrefixes.has(w)
  );
  if (structuralWarnings.length > 0) {
    if (commentLines.length > 0) commentLines.push('');
    commentLines.push('Additionally:', '', ...structuralWarnings.map(w => `- ${w}`));
  }

  // Add semantic review section if --deep findings exist
  if (result.semanticFindings && result.semanticFindings.length > 0) {
    commentLines.push('', '**Semantic Review:**', '');
    for (const f of result.semanticFindings) {
      commentLines.push(`- **[${f.category}]** ${f.message}`);
      commentLines.push(`  _Recommendation:_ ${f.recommendation}`);
    }
  }

  // Post main comment on this ticket
  if (commentLines.length > 0) {
    try {
      await clickup.commentOnTask(ticketId, commentLines.join('\n'));
      showSuccess('Posted requirements comment on ticket');
    } catch (error) {
      console.error(`Failed to post validation comment on ${ticketId}:`, error instanceof Error ? error.message : error);
    }
  }

  // Post hierarchy findings — summary on parent, targeted on individual subtasks
  if (result.hierarchyFindings && result.hierarchyFindings.length > 0) {
    // Group findings by ticketId
    const byTicket = new Map<string, SemanticFinding[]>();
    const parentFindings: SemanticFinding[] = [];

    for (const f of result.hierarchyFindings) {
      if (f.ticketId && f.ticketId !== ticketId) {
        const existing = byTicket.get(f.ticketId) ?? [];
        existing.push(f);
        byTicket.set(f.ticketId, existing);
      } else {
        parentFindings.push(f);
      }
    }

    // Post summary on parent ticket
    const summaryLines = ['**Hierarchy Analysis:**', ''];
    for (const f of result.hierarchyFindings) {
      const icon = f.severity === 'warning' ? '⚠️' : '💡';
      const target = f.ticketId ? ` (${f.ticketId})` : '';
      summaryLines.push(`${icon} **[${f.category}]** ${f.message}${target}`);
      summaryLines.push(`   _→ ${f.recommendation}_`);
    }
    try {
      await clickup.commentOnTask(ticketId, summaryLines.join('\n'));
      showSuccess('Posted hierarchy analysis on parent ticket');
    } catch (error) {
      console.error(`Failed to post hierarchy comment on ${ticketId}:`, error instanceof Error ? error.message : error);
    }

    // Post targeted comments on individual subtasks in parallel
    await Promise.all(Array.from(byTicket).map(async ([subId, findings]) => {
      const subLines = ['**Hierarchy Review:**', ''];
      for (const f of findings) {
        const icon = f.severity === 'warning' ? '⚠️' : '💡';
        subLines.push(`${icon} **[${f.category}]** ${f.message}`);
        subLines.push(`   _→ ${f.recommendation}_`);
      }
      try {
        await clickup.commentOnTask(subId, subLines.join('\n'));
        showSuccess(`Posted hierarchy findings on subtask ${subId}`);
      } catch (error) {
        console.error(`Failed to post hierarchy comment on subtask ${subId}:`, error instanceof Error ? error.message : error);
      }
    }));
  }
}
