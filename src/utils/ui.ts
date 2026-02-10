import chalk from 'chalk';
import boxen from 'boxen';
import ora, { Ora } from 'ora';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { dirname } from 'path';
import { createInterface } from 'readline';
import { parse } from 'shell-quote';

export function createSpinner(text: string): Ora {
  return ora({ text, color: 'cyan' });
}

export function showBox(content: string, title?: string): void {
  console.log(boxen(content, {
    padding: 1,
    margin: { top: 1, bottom: 1, left: 0, right: 0 },
    borderColor: 'gray',
    title: title,
    titleAlignment: 'left',
  }));
}

export function showSuccess(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

export function showError(message: string): void {
  console.log(chalk.red(`✗ ${message}`));
}

export function showWarning(message: string): void {
  console.log(chalk.yellow(`⚠ ${message}`));
}

export function showInfo(message: string): void {
  console.log(chalk.blue(`ℹ ${message}`));
}

/**
 * Write content to a file, open it in the user's editor, wait for Enter, read it back.
 * Uses VISUAL env var (set from config.editor) or falls back to showing the path.
 */
export async function editExternally(content: string, filePath: string): Promise<string> {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');

  // Try to open in configured editor (non-blocking)
  const editorCmd = process.env.VISUAL || process.env.EDITOR;
  if (editorCmd) {
    const parts = parse(editorCmd).filter((p): p is string => typeof p === 'string');
    const cmd = parts[0];
    // Filter out --wait since we handle waiting ourselves
    const args = [...parts.slice(1).filter(a => a !== '--wait'), filePath];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    console.log(`\n  ${chalk.dim('Opened in')} ${chalk.cyan(cmd)}`);
  } else {
    console.log(`\n  ${chalk.dim('Edit this file:')} ${chalk.cyan(filePath)}`);
  }

  console.log(chalk.dim('  Press Enter when done editing.\n'));
  await waitForEnter();

  return readFileSync(filePath, 'utf-8');
}

function waitForEnter(): Promise<void> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

export function formatPrStatus(status: {
  ciPassed: boolean;
  ciPending: number;
  ciFailed: string[];
  approvals: string[];
  changesRequested: string[];
}): string {
  const lines: string[] = [];

  // CI Status
  if (status.ciPassed && status.ciPending === 0) {
    lines.push(chalk.green('✓ CI: All checks passed'));
  } else {
    if (status.ciFailed.length > 0) {
      lines.push(chalk.red(`✗ CI: ${status.ciFailed.length} failed`));
      status.ciFailed.forEach(name => {
        lines.push(chalk.red(`    - ${name}`));
      });
    }
    if (status.ciPending > 0) {
      lines.push(chalk.yellow(`◔ CI: ${status.ciPending} pending`));
    }
  }

  // Review Status
  if (status.approvals.length > 0) {
    lines.push(chalk.green(`✓ Reviews: Approved by ${status.approvals.join(', ')}`));
  }
  if (status.changesRequested.length > 0) {
    lines.push(chalk.red(`✗ Reviews: Changes requested by ${status.changesRequested.join(', ')}`));
  }
  if (status.approvals.length === 0 && status.changesRequested.length === 0) {
    lines.push(chalk.yellow('◔ Reviews: Waiting for review'));
  }

  return lines.join('\n');
}
