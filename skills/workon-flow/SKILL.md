---
name: workon-flow
description: "ClickUp ticket workflow: discover tasks, validate readiness, start work, and route cross-repo subtasks. Use when the user says 'workon', mentions a ticket ID, asks 'what should I work on', 'next task', 'validate', or anything about ClickUp tickets and subtasks."
argument-hint: "[ticket-id | next | tasks | context | validate]"
allowed-tools: Bash(workon:*), Bash(git:*), Read
---

# Workon Flow

> **Note**: workon-flow and workon-delivery are companion skills. Flow handles ticket discovery through implementation; Delivery handles the PR lifecycle through merge. They hand off to each other at defined boundaries.

Orchestrate the full pre-coding workflow: discover tickets, validate readiness, start work in the correct repo, and manage cross-platform subtask routing.

## Current Workflow State
!`workon context 2>/dev/null || echo "No active workflow"`

## Current Repo
!`git remote get-url origin 2>/dev/null | sed 's/.*\///' | sed 's/.git$//' || echo "Not in a git repo"`

## CLI Commands

| Command | Purpose |
|---------|---------|
| `workon start <id> --yes` | Create/checkout branch, update status to IN PROGRESS |
| `workon start <id> --yes --cwd <path>` | Start in a specific repo directory |
| `workon ticket [id]` | Show ticket details (title, status, description, AC) |
| `workon ticket [id] --json` | Structured ticket data including comments and subtasks |
| `workon ticket-update [id] --status "..." --description "..."` | Update ticket fields |
| `workon ticket-comment "..." --ticket <id>` | Comment on ticket (`--ticket` targets any ticket) |
| `workon ticket-create --name "..." --description "..."` | Create new ticket |
| `workon subtasks [id] --json` | List subtasks with platform and repo path resolution |
| `workon validate [id] --json` | Check ticket readiness (description, AC, platform, assignee) |
| `workon validate [id] --deep` | Structural + semantic analysis (AI-powered) |
| `workon validate [id] --hierarchy --deep --json` | Cross-validate parent + subtasks |
| `workon validate [id] --comment` | Post missing requirements as comment on ticket |
| `workon review [id] --deep` | Interactive AI-assisted ticket refinement |
| `workon review [id] --deep --reviewer codex` | With secondary model review (codex or gemini) |
| `workon tasks` | List assigned tasks |
| `workon tasks --status "ready for eng" "on deck"` | Filter by status |
| `workon tasks --json` | Structured task list |
| `workon next` | Interactive picker for next task |
| `workon context` | Show current workflow state and recommended next action |
| `workon context --json` | Structured workflow context |
| `workon agent --once` | Single poll for new tasks, validates and comments |
| `workon init` | Initialize configuration file |
| `workon worktree add <id>` | Create worktree for background agent work |
| `workon worktree list [--json]` | Show all worktrees with pipeline status |
| `workon worktree remove <id> [--keep]` | Remove worktree + branch |
| `workon worktree status [id] [--json]` | Detailed status of one or all worktrees |
| `workon worktree update-status --stage X` | Update pipeline stage (for agents) |
| `workon start <id> --worktree` | Sugar: create worktree, print path |

See `commands-reference.md` for detailed flag reference.

## Error Handling

When a CLI command fails:
- **Network/API errors**: retry once, then report to user
- **Invalid ticket ID or permissions**: report to user immediately
- **CLI not found or config missing**: run `workon init` or check installation
- **Never proceed to the next workflow step if the current step fails**

## Workflow: Starting Work on a Ticket

When user provides a ticket ID:

1. **Fetch ticket context**:
   ```bash
   workon ticket <id> --json
   ```

2. **Check for subtasks** (may be a parent ticket):
   ```bash
   workon subtasks <id> --json
   ```
   - If subtasks exist, this is a **cross-platform ticket** — see Cross-Repo Orchestration below
   - If no subtasks, continue with single-ticket flow

3. **Validate readiness** (use `--deep` for AI-powered semantic analysis):
   ```bash
   workon validate <id> --json --deep
   ```
   - If `ready: false`, show the issues and ask the user how to proceed
   - Options: fix the ticket (update description/fields), comment asking for info, or proceed anyway
   - With `--deep`, also checks clarity, acceptance criteria quality, missing context, ambiguity, and scope
   - For interactive ticket refinement, use `workon review <id> --deep` instead

4. **Start work**:
   ```bash
   workon start <id> --yes
   ```
   - If the ticket has a mapped repo path (from Platform field), use `--cwd`:
     ```bash
     workon start <id> --yes --cwd <repo-path>
     ```

5. **Load context** for the coding session:
   ```bash
   workon ticket
   ```
   Show the ticket description and acceptance criteria so the agent understands the work.

## Workflow: Finding Next Task

When user says "next" or "what should I work on?":

```bash
workon tasks --status "ready for eng" "on deck" --json
```

Present the tasks. If user picks one, start the ticket ID flow above.

Alternatively, use the interactive picker:
```bash
workon next
```

## Workflow: Context Recovery

When re-entering after a session break:

```bash
workon context
```

Follow the recommended action in the output. This shows: active ticket, branch, PR state, CI status, and what to do next.

## Workflow: Hierarchy Validation

Before starting cross-platform work, validate the full hierarchy:

```bash
workon validate <parent-id> --hierarchy --deep --json
```

This cross-validates parent requirements against subtask coverage, checks shared contracts (API endpoints, setting names), detects thin subtasks, and suggests execution order.

If findings exist (especially `coverage-gap`, `contract-mismatch`, `thin-subtask`):
1. Show findings to user
2. Improve thin subtasks:
   ```bash
   workon review <subtask-id> --hierarchy --deep
   ```
3. Or improve all subtasks from the parent level:
   ```bash
   workon review <parent-id> --hierarchy --deep
   ```
4. Re-validate after improvements

Use `dependencyOrder` from the JSON result to plan execution. It returns **tiers** — each tier is an array of subtask IDs that can run in parallel. Tiers are sequential: complete all tasks in tier 1 before starting tier 2.

Example: `[["86b8dq334"], ["86b8dq3f0", "86b8dq3g1"]]` means the Rails subtask runs first, then Android and iOS can start in parallel.

## Workflow: Cross-Repo Orchestration

When a parent ticket has subtasks with different Platform fields:

1. **Map the execution plan**:
   ```bash
   workon subtasks <parent-id> --json
   ```
   Parse the JSON to build a table:
   | Subtask ID | Name | Platform | Repo Path | Status |
   |------------|------|----------|-----------|--------|

2. **Determine order**: Use `workon validate <parent-id> --hierarchy --json` and check `dependencyOrder`. Backend/API subtasks first (e.g., POS Rails creates the setting), then client subtasks (e.g., Android reads it). If no dependency, order doesn't matter.

3. **Validate with hierarchy context**:
   ```bash
   workon validate <parent-id> --hierarchy --deep --json
   ```
   This validates all subtasks and checks cross-cutting concerns in one pass. Comment on any that need info. Only start subtasks that pass validation.

4. **Work subtasks by tier** (from `dependencyOrder`):
   - Subtasks within the same tier can run **in parallel** (e.g., via subagents in separate repo directories)
   - Tiers are sequential: finish all tier 1 subtasks before starting tier 2
   ```bash
   # Start each subtask in its repo:
   workon start <subtask-id> --yes --cwd <repo-path>
   ```
   Then **hand off to workon-delivery** for the PR lifecycle (create PR, handle CI/review, merge, cleanup).

   After all subtasks in a tier are merged, start the next tier.

5. **Re-entry after partial completion** (e.g., resuming a cross-platform ticket hours later):
   ```bash
   workon subtasks <parent-id> --json
   ```
   Check subtask statuses — skip any that are already closed/done. Start the next pending subtask from step 4.

6. **Parent rollup** — after all subtasks are merged:
   ```bash
   workon subtasks <parent-id> --json
   ```
   Check if all subtasks are in a closed/done status. If yes:
   ```bash
   workon ticket-update <parent-id> --status "closed"
   workon ticket-comment "All subtasks completed and merged." --ticket <parent-id>
   ```
   Note: Use `--ticket <parent-id>` because after cleanup you are on the base branch with no ticket context.

## Workflow: Automated Mode

When the user says "auto", "run it", "just do it", or explicitly asks for minimal intervention, assess whether the ticket qualifies for automated execution.

### Automatability Assessment

Run the assessment before committing to auto mode:

```bash
workon validate <id> --deep --json
workon subtasks <id> --json
```

**Auto-eligible if ALL of these are true:**
- `ready: true` from deep validation
- No semantic findings with category `coverage-gap`, `contract-mismatch`, or `thin-subtask`
- No subtasks (single-repo ticket) — parent-level cross-repo orchestration requires guided mode
- Individual subtasks within a cross-repo ticket CAN run in auto mode if they independently pass auto-eligibility checks
- Acceptance criteria are concrete and testable (not vague like "improve performance")
- No open questions or ambiguity flagged by `--deep`

**Report the assessment to the user:**
```
Automatability: HIGH / MEDIUM / LOW

- Validation: passed/failed
- Semantic findings: none / [list]
- Scope: single-repo / cross-repo
- AC quality: concrete / vague
- Open questions: none / [list]

Recommendation: auto / guided
```

If **HIGH** — proceed automatically. If **MEDIUM** — ask user to confirm. If **LOW** — fall back to guided mode and explain why.

### Auto Execution Pipeline

Once assessed as auto-eligible, run this pipeline without pausing for confirmation at each step:

1. **Start** → `workon start <id> --yes`
2. **Plan** → Read ticket AC, derive implementation plan, write `current/IMPLEMENTATION.md` and `current/STEPS.md` directly (no discussion — the ticket IS the spec)
3. **Implement** → For each step in STEPS.md:
   - Write `current/TODO.md` with concrete tasks
   - Implement the code
   - Run tests, fix failures
   - Commit with descriptive message
   - Update STEPS.md with implementation notes
4. **Self-verify** → Before creating PR, check every acceptance criterion from the ticket:
   - Run relevant tests
   - Verify each AC item is addressed in the code
   - If any AC is not met, fix it before proceeding
5. **Create PR** → `workon pr -y --title "..." ...` (no approval pause — AC-driven content)
6. **Monitor CI** → `workon ci-status`, and if failures: `workon ci-failure` → fix → `workon pr-push --yes` (up to 3 attempts)
7. **Handle reviews** → `workon pr-review` → address feedback → `workon pr-push --yes`
8. **STOP at merge** → Always report back to user: "PR is approved and CI is green. Ready to merge?" Merge is never automated.

### Auto Mode Guardrails

- **Max 3 CI fix attempts** — after 3 failures, stop and report to user
- **Review changes > 20 lines of rework** — if a reviewer requests large changes, stop and consult user
- **Scope creep detection** — if implementation requires changes outside what the ticket describes, stop
- **Test failures in unmodified code** — if tests you didn't write or modify are failing (flaky tests, environment issues), stop and report to user
- **Merge is always human-gated** — never auto-merge

### Resuming Auto Mode

If auto mode was interrupted (session break, blocker), on resume:
```bash
workon context
```
Check where the pipeline stopped and continue from that point. The `current/` files and PR state provide full recovery context.

## Workflow: Background Development (Worktrees)

Use git worktrees to run multiple subtasks in parallel within the same repo. Each worktree gets its own directory and branch, so background Claude agents can work independently while the main worktree stays free.

```
main worktree:  human works interactively (or idle)
     ├── .worktrees/86b6ycnw1/:  background claude → auto-mode → PR
     ├── .worktrees/86b8dq334/:  background claude → auto-mode → PR
     └── (other repo):            background claude → another subtask
```

### Creating a worktree for a subtask

```bash
workon worktree add <subtask-id>
```

This fetches the ticket, creates a branch from the base branch, writes a `.workon-status.json` status file, and prints the worktree path as the last line of output.

### Launching a background agent

```bash
claude --cwd $(workon worktree add <subtask-id> | tail -1) -p "workon auto <subtask-id>"
```

Or use `--worktree` on start:
```bash
claude --cwd $(workon start <subtask-id> --worktree | tail -1) -p "workon auto <subtask-id>"
```

### Agent status reporting

Background agents should update their pipeline stage as they progress:
```bash
workon worktree update-status --stage planning
workon worktree update-status --stage implementing
workon worktree update-status --stage pr-created --pr-url <url> --pr-number <n>
workon worktree update-status --stage blocked --blocked "CI timeout on flaky test"
```

Valid stages: `starting`, `planning`, `implementing`, `pr-created`, `ci-fixing`, `review-addressing`, `ready-to-merge`, `blocked`, `completed`.

### Monitoring progress

```bash
workon worktree list          # Table of all worktrees with stage, ticket name, PR URL
workon worktree status <id>   # Detailed status of one worktree
workon context                # Includes "Background Work" section with all worktrees
```

### Cleanup

Automatic after merge: `workon cleanup` inside a worktree removes the worktree and deletes the branch.

Manual removal:
```bash
workon worktree remove <id>         # Remove worktree + branch (warns if not completed)
workon worktree remove <id> --keep  # Remove worktree, keep branch for debugging
workon worktree remove <id> -y      # Skip confirmation
```

## Safety Rules

- Always show ticket context before starting code changes
- Warn (don't block) on validation issues — human decides whether to proceed
- Never modify code without first understanding the ticket requirements
- For cross-repo work, complete and merge one subtask before starting the next (unless same tier)
- For mergebot repos, if merge polling times out (60s), run `workon context` later to confirm before starting the next subtask
- In auto mode: merge is ALWAYS human-gated, scope creep triggers a stop, max 3 CI fix retries
