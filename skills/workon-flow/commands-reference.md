# Workon Flow — Commands Reference

Detailed flag reference for all ticket and workflow CLI commands.

## workon start

Start work on a ticket: creates/checks out a feature branch and updates ClickUp status to IN PROGRESS.

```
workon start [ticket-id] [options]
```

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Skip confirmation prompts |
| `--cwd <path>` | Run in a different repo directory |
| `--dry-run` | Show what would be done without executing |

If ticket-id is omitted, uses the ticket from the current branch.

## workon ticket

Show ticket details from ClickUp.

```
workon ticket [ticket-id] [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON (includes comments, subtasks, custom fields) |

If ticket-id is omitted, uses the ticket from the current branch.

## workon ticket-update

Update a ClickUp ticket's fields.

```
workon ticket-update [ticket-id] [options]
```

| Flag | Description |
|------|-------------|
| `--status <status>` | Set ticket status (e.g., "in progress", "closed") |
| `--description <text>` | Update ticket description |
| `--name <text>` | Update ticket title |

## workon ticket-comment

Add a comment to a ClickUp ticket.

```
workon ticket-comment [comment] [options]
```

| Flag | Description |
|------|-------------|
| `--ticket <id>` | Target a specific ticket (overrides current branch ticket) |

## workon ticket-create

Create a new ClickUp ticket (non-interactive).

```
workon ticket-create [options]
```

| Flag | Description |
|------|-------------|
| `--name <name>` | Ticket title (required) |
| `--description <text>` | Ticket description |

## workon subtasks

List subtasks for a ClickUp ticket with platform and repo path resolution.

```
workon subtasks [ticket-id] [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON with platform mapping and repo paths |

## workon validate

Check ticket readiness: description, acceptance criteria, platform, assignee.

```
workon validate [ticket-id] [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON result |
| `--deep` | Enable AI-powered semantic analysis (clarity, scope, ambiguity) |
| `--hierarchy` | Cross-validate parent requirements against subtask coverage |
| `--comment` | Post missing requirements as a comment on the ticket |
| `--reviewer <model>` | Use secondary model for review (codex or gemini) |

## workon review

Interactive AI-assisted ticket refinement. Analyzes and optionally pushes updates back to ClickUp.

```
workon review [ticket-id] [options]
```

| Flag | Description |
|------|-------------|
| `--deep` | Enable deep semantic analysis |
| `--hierarchy` | Include cross-platform hierarchy context |
| `--reviewer <model>` | Use secondary model (codex or gemini) |

## workon tasks

List tasks assigned to you.

```
workon tasks [options]
```

| Flag | Description |
|------|-------------|
| `--status <statuses...>` | Filter by status (e.g., `"ready for eng" "on deck"`) |
| `--json` | Output structured JSON |

## workon next

Interactive picker for next task. Shows assigned tickets and lets you pick one to start.

```
workon next [options]
```

## workon context

Show workflow context: active ticket, git branch, PR state, CI status, and recommended next action.

```
workon context [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON |

## workon agent

Start agent polling mode — watches for new tasks, PR reviews, CI failures.

```
workon agent [options]
```

| Flag | Description |
|------|-------------|
| `--once` | Single poll cycle instead of continuous watching |

## workon init

Initialize workon configuration file in the current repo.

```
workon init
```

## workon cleanup

Switch to base branch, pull latest, and delete the current feature branch.

```
workon cleanup [options]
```

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Skip confirmation |
