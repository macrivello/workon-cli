/**
 * Utilities for reading piped input from stdin
 */

/** Maximum allowed stdin size: 10 MB */
const MAX_STDIN_SIZE = 10 * 1024 * 1024;

/**
 * Check if stdin has piped input (not from a TTY)
 */
export function isStdinPiped(): boolean {
  return !process.stdin.isTTY;
}

/**
 * Read all content from stdin
 * Returns empty string if stdin is a TTY (no piped input)
 * Throws if input exceeds MAX_STDIN_SIZE (10 MB)
 */
export async function readStdin(): Promise<string> {
  if (!isStdinPiped()) {
    return '';
  }

  return new Promise((resolve, reject) => {
    let data = '';
    let totalBytes = 0;

    process.stdin.setEncoding('utf8');

    process.stdin.on('readable', () => {
      let chunk: string | null;
      while ((chunk = process.stdin.read() as string | null) !== null) {
        totalBytes += Buffer.byteLength(chunk, 'utf8');
        if (totalBytes > MAX_STDIN_SIZE) {
          process.stdin.destroy();
          reject(new Error(`Stdin input exceeds maximum allowed size of ${MAX_STDIN_SIZE / (1024 * 1024)} MB`));
          return;
        }
        data += chunk;
      }
    });

    process.stdin.on('end', () => {
      resolve(data.trim());
    });

    process.stdin.on('error', (err) => {
      reject(err);
    });
  });
}
