---
name: workon-delivery
description: "PR lifecycle: create PRs, handle review feedback, monitor CI, fix failures, merge, and cleanup. Use when the user says 'create PR', 'open PR', 'pr status', 'push changes', 'address review', 'fix CI', 'merge', 'code review', or anything about pull requests and merging."
argument-hint: "[pr | pr-status | pr-review | ci-status | merge]"
allowed-tools: Bash(workon:*), Bash(gh:*), Bash(git:*), Read, Grep, Glob
---

# Workon Delivery

Orchestrate the full PR lifecycle: create PRs, monitor CI, handle review feedback, merge with per-repo strategy, and cleanup.

## Current Workflow State
!`workon context 2>/dev/null || echo "No active workflow"`

## PR State
!`workon pr-status 2>/dev/null || echo "No open PR for current branch"`

## PR Template
!`cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null || echo "No PR template in this repo"`

## CLI Commands

| Command | Purpose |
|---------|---------|
| `workon pr --title "..." --summary "..." --description "..." --testing "..."` | Create PR |
| `workon pr --draft ...` | Create as draft PR |
| `workon pr -y ...` | Skip confirmation (use after user already approved) |
| `workon pr-update [pr-number] --title "..." --summary "..." --description "..." --testing "..."` | Update PR sections |
| `workon pr-status [pr-number]` | Check CI + review status |
| `workon pr-review [pr-number]` | Show review comments and feedback |
| `workon pr-review --json` | Structured review data |
| `workon pr-comment --reply-to <id> --body "..."` | Reply to inline review comment |
| `workon pr-push [pr-number] --yes` | Push changes + re-request review |
| `workon pr-ready [pr-number] --yes` | Mark draft PR as ready for review |
| `workon ci-status [branch]` | Check CircleCI status |
| `workon ci-failure [job-number]` | Get detailed CI failure output |
| `workon merge --yes` | Merge PR (uses per-repo strategy from config) |
| `workon cleanup --yes` | Switch to base branch, pull, delete feature branch |
| `workon context` | Show current workflow state |

## Workflow: Creating a PR

### Guided Mode (default)

1. **Gather context**:
   ```bash
   git diff origin/HEAD...HEAD
   git log --oneline origin/HEAD...HEAD
   ```
   The repo's PR template is injected above via dynamic context.

2. **Generate PR content** following the repo's PR template (injected above). If no template exists, use:
   - **Title**: concise description of the change
   - **Summary**: 1-2 sentences on what changed and why
   - **Description**: detailed explanation referencing files/functions
   - **Testing**: step-by-step verification instructions

3. **Get user approval**: Show the generated content. Wait for explicit "yes" before creating.

4. **Create the PR**:
   ```bash
   workon pr -y --title "..." --summary "..." --ticket "<id>" --description "..." --testing "..."
   ```
   Add `--draft` if the user wants a draft PR.
   Add `--base <branch>` only if the base branch is not the default.

### Auto Mode

When invoked as part of an automated pipeline (workon-flow auto mode), skip the approval step:

1. Gather context (same as above)
2. Generate PR content from the diff, commit log, and ticket AC
3. Create immediately: `workon pr -y --title "..." ...` — no pause for approval
4. Proceed to CI monitoring

## Workflow: Updating a PR

If the PR description needs changes (wrong title, missing context, outdated testing steps):
```bash
workon pr-update --title "..." --summary "..." --description "..." --testing "..."
```
Only pass the sections you want to change. Use `"-"` to read a section from stdin.

## Workflow: Handling CI Failures

### Guided Mode

1. Check status:
   ```bash
   workon ci-status
   ```

2. If failures, get details:
   ```bash
   workon ci-failure
   ```
   If multiple jobs failed, pass the specific job number: `workon ci-failure <job-number>`.

3. Read the failure output, identify the root cause, fix the code.

4. Push the fix:
   ```bash
   workon pr-push --yes
   ```

### Auto Mode

In auto mode, CI fix is a loop with a retry limit:

1. `workon ci-status` — if green, move on
2. If red: `workon ci-failure` → diagnose → fix → `workon pr-push --yes`
3. Wait for CI, repeat up to **3 attempts**
4. After 3 failures, **stop and report to user** with the failure details

## Workflow: Handling Review Feedback

### Guided Mode

1. See what reviewers said:
   ```bash
   workon pr-review
   ```

2. Address each comment — fix code or reply:
   ```bash
   workon pr-comment --reply-to <comment-id> --body "Fixed in latest commit"
   ```

3. Push changes and re-request review:
   ```bash
   workon pr-push --yes
   ```

### Auto Mode

In auto mode, review feedback is addressed autonomously unless the rework is large:

1. `workon pr-review --json` — parse all comments
2. For each comment: fix code or reply with explanation
3. **Scope check**: if addressing feedback requires > 20 lines of new/changed code, **stop and report to user** — the reviewer may be requesting a design change
4. Push: `workon pr-push --yes`

## Workflow: Concurrent CI + Review

When both CI is failing and changes are requested:
1. Fix the code issues from review feedback first (they may also fix CI).
2. Push once: `workon pr-push --yes`.
3. If CI still fails after addressing review, run `workon ci-failure` to diagnose remaining issues.
4. Push again after fixing CI: `workon pr-push --yes`.

## Workflow: Draft PR

For work that needs early visibility or is not yet complete:
1. Create draft: `workon pr --draft --title "..." --summary "..." ...`
2. Continue working, push updates with `git push`
3. If the PR description needs updating after new commits: `workon pr-update --summary "..." --description "..."`
4. When the work is complete and ready for review: `workon pr-ready --yes`
5. Normal review/merge flow from here

## Workflow: Merging

**Merge is human-gated.** Only proceed when the user explicitly asks to merge.

1. Verify readiness:
   ```bash
   workon pr-status
   ```

2. Show status to user. Confirm they want to merge.

3. Merge:
   ```bash
   workon merge --yes
   ```
   The merge command automatically:
   - Detects the repo's merge strategy from config (mergebot or squash)
   - For **mergebot**: posts `/merge` comment, polls for completion
   - For **squash**: runs `gh pr merge --squash` directly
   - Updates ticket status to CLOSED
   - Comments on ticket with PR number
   - Runs cleanup (switch to base, pull, delete branch)

4. After cleanup, **hand off to workon-flow** for next steps:
   - If this was a subtask of a cross-platform ticket, workon-flow will check remaining subtasks and start the next one.
   - If this was a standalone ticket, workon-flow will recommend picking the next task.

## Workflow: Code Review

When performing a code review of the current branch:

1. **Identify changed files**:
   ```bash
   git diff --name-only origin/main...HEAD
   ```

2. **Create `CODE_REVIEW.md`** with this structure:
   ```markdown
   # Code Review

   ## Links

   ## PR Description

   ## Changes Summary

   ## Requirements Satisfied

   ## Feedback

   ## Testing

   ## Questions

   ## Review Decision
   ```

3. **Gather requirements**: Ask the user to paste in the ticket requirements and testing instructions. Add links to the **Links** section.

4. **Analyze changes**:
   - Check classes used in the diff — could there be impact outside the changed code?
   - Review spec files for those classes
   - Evaluate whether all ticket requirements are satisfied (**Requirements Satisfied**)
   - Provide only critical, actionable feedback (**Feedback**) — no positive-only comments
   - Find edge cases that should be investigated, citing specific code locations
   - Assess automated test coverage — are important paths missing tests? (**Testing**)

5. **Leave Review Decision blank** for the reviewer to fill in.

## Safety Rules

- Never merge without explicit user confirmation — even in auto mode
- Never force-push or run destructive git commands
- Always show PR status before merging
- If CI is failing or reviews are pending, warn the user before proceeding
- In auto mode: max 3 CI fix attempts, stop on large rework requests, merge is always human-gated
