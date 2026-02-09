# PR Content Guidelines

## PR Title
- Concise description of the change (under 70 characters)
- Use imperative mood: "Add...", "Fix...", "Update..."
- Include ticket ID if applicable

## PR Summary
1-2 sentences explaining what changed and why. This appears at the top of the PR description.

## PR Description
Detailed explanation of the change:
- What was the problem?
- What approach was taken?
- What files/functions were modified and why?
- Any trade-offs or decisions worth noting?

## Testing Instructions
Step-by-step instructions for verifying the change:
1. Setup steps (if any)
2. What to do
3. What to expect
4. Edge cases to check

## CODE_REVIEW.md Template

When performing code reviews, create `CODE_REVIEW.md` with this structure:

```markdown
# Code Review

## Links
- PR: [link]
- Ticket: [link]

## PR Description
[Copy from the PR]

## Changes Summary
[Analysis of all changed files, potential impact on unchanged code, classes and interfaces affected]

## Requirements Satisfied
- [ ] [Requirement 1 from ticket] — satisfied/not satisfied
- [ ] [Requirement 2 from ticket] — satisfied/not satisfied

## Feedback
[Only critical, actionable feedback. No positive-only comments.]
- **[file:line]**: [Issue description and suggested fix]
- **[file:line]**: [Issue description and suggested fix]

## Testing
[Assessment of automated test coverage]
- Missing coverage for: [important paths without tests]
- Existing tests: [relevant tests that cover the changes]

## Questions
- [Clarifying questions about the implementation]
- [Edge cases that should be investigated]

## Review Decision
[Left blank for reviewer to fill in]
```

### Code Review Analysis Guidelines

When populating CODE_REVIEW.md:
- Analyze classes used in the diff to evaluate impact outside of changed code
- Check spec files for modified classes
- Look for edge cases — cite specific areas of code that should be checked
- Only provide critical, actionable feedback — skip positive-only comments
- Assess whether all ticket acceptance criteria are met
- Identify important code paths that lack automated test coverage
