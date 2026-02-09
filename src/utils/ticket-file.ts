import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { EnrichedTicket, ClickUpComment, ClickUpSubtask } from '../types.js';
import type { ClickUpClient } from '../services/clickup.js';

const TICKETS_DIR = join(homedir(), '.config', 'workon', 'tickets');

export function getTicketsDirectory(): string {
  return TICKETS_DIR;
}

export function getTicketFilePath(ticketId: string): string {
  return join(TICKETS_DIR, `${ticketId}.md`);
}

export function ticketFileExists(ticketId: string): boolean {
  return existsSync(getTicketFilePath(ticketId));
}

export function writeTicketFile(ticketId: string, content: string): void {
  if (!existsSync(TICKETS_DIR)) {
    mkdirSync(TICKETS_DIR, { recursive: true });
  }
  writeFileSync(getTicketFilePath(ticketId), content, 'utf-8');
}

export function readTicketFile(ticketId: string): string | null {
  const path = getTicketFilePath(ticketId);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

/**
 * Fetch enriched ticket data: task + comments + subtasks in parallel
 */
export async function fetchEnrichedTicket(
  clickup: ClickUpClient,
  ticketId: string,
): Promise<EnrichedTicket> {
  const [task, comments, subtasks] = await Promise.all([
    clickup.getTask(ticketId),
    clickup.getTaskComments(ticketId).catch(() => [] as ClickUpComment[]),
    clickup.getTaskSubtasks(ticketId).catch(() => [] as ClickUpSubtask[]),
  ]);
  return { task, comments, subtasks };
}

/**
 * Render an enriched ticket as markdown with YAML frontmatter
 */
export function renderMarkdown(ticket: EnrichedTicket): string {
  const { task, comments, subtasks } = ticket;

  const assigneeNames = task.assignees.map(a => a.username);

  const lines: string[] = [
    '---',
    `id: "${task.id}"`,
    `name: "${escapeFrontmatter(task.name)}"`,
    `status: "${task.status.status}"`,
    `url: "${task.url}"`,
  ];
  if (assigneeNames.length > 0) {
    lines.push('assignees:');
    for (const name of assigneeNames) {
      lines.push(`  - "${name}"`);
    }
  }
  lines.push('---', '');

  // Description
  const description = task.text_content || task.description || '';
  lines.push(description);

  // Comments section
  if (comments.length > 0) {
    lines.push('', '---', '', '## Comments', '');
    for (const comment of comments) {
      const date = new Date(parseInt(comment.date, 10)).toISOString().split('T')[0];
      lines.push(`**${comment.user.username}** (${date}):`);
      lines.push(comment.comment_text);
      lines.push('');
    }
  }

  // Subtasks section
  if (subtasks.length > 0) {
    lines.push('', '---', '', '## Subtasks', '');
    for (const sub of subtasks) {
      const done = sub.status.status.toLowerCase() === 'closed' ||
                   sub.status.status.toLowerCase() === 'complete';
      lines.push(`- [${done ? 'x' : ' '}] ${sub.id}: ${sub.name} (${sub.status.status})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render enriched ticket as JSON
 */
export function renderJSON(ticket: EnrichedTicket): string {
  return JSON.stringify(ticket, null, 2);
}

/**
 * Parse a ticket markdown file back into metadata + description.
 * Only the description (content before the first --- separator after frontmatter) is editable.
 */
export function parseTicketMarkdown(content: string): {
  id: string;
  name: string;
  description: string;
} {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error('Invalid ticket file: missing YAML frontmatter');
  }

  const frontmatter = frontmatterMatch[1];
  const id = extractYamlValue(frontmatter, 'id');
  const name = extractYamlValue(frontmatter, 'name');

  if (!id) throw new Error('Invalid ticket file: missing id in frontmatter');
  if (!name) throw new Error('Invalid ticket file: missing name in frontmatter');

  // Description is everything after frontmatter, up to the Comments or Subtasks section.
  // We look for "\n---\n\n## Comments" or "\n---\n\n## Subtasks" specifically,
  // not just "\n---\n" which could appear as a markdown horizontal rule in the description.
  const afterFrontmatter = content.slice(frontmatterMatch[0].length);
  const sectionPattern = /\n---\n\n## (?:Comments|Subtasks)\n/;
  const sectionMatch = afterFrontmatter.match(sectionPattern);
  const description = sectionMatch
    ? afterFrontmatter.slice(0, sectionMatch.index).trim()
    : afterFrontmatter.trim();

  return { id, name, description };
}

function extractYamlValue(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${key}:\\s*"([\\s\\S]+?)"`, 'm'));
  if (!match) return '';
  // Unescape in reverse order of escaping: \\\\ → \\, then \\" → ", then \\n → \n
  // We use a placeholder to avoid double-replacement of backslashes
  return match[1]
    .replace(/\\\\/g, '\x00')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\x00/g, '\\');
}

function escapeFrontmatter(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}
