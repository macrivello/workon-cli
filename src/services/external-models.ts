import { spawnSync } from 'child_process';

/**
 * Check if codex CLI is available
 */
export function isCodexAvailable(): boolean {
  try {
    const result = spawnSync('which', ['codex'], { encoding: 'utf-8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Generate text using codex exec
 */
export async function codexGenerate(prompt: string): Promise<string> {
  try {
    const result = spawnSync('codex', ['exec', prompt], {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || 'codex command failed');
    }

    return result.stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Codex generation failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Check if gemini CLI is available
 */
export function isGeminiAvailable(): boolean {
  try {
    const result = spawnSync('which', ['gemini'], { encoding: 'utf-8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Generate text using gemini CLI with optional context piped as stdin
 */
export async function geminiGenerate(prompt: string, context?: string): Promise<string> {
  try {
    const result = spawnSync('gemini', ['-p', prompt], {
      encoding: 'utf-8',
      timeout: 90000,
      maxBuffer: 2 * 1024 * 1024,
      ...(context ? { input: context } : {}),
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || 'gemini command failed');
    }

    return result.stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Gemini generation failed: ${error.message}`);
    }
    throw error;
  }
}
