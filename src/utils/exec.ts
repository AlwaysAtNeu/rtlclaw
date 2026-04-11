/**
 * Shared async exec and path safety utilities.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Async exec with abort + timeout support
// ---------------------------------------------------------------------------

export interface ExecAsyncOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  timeout?: number;
  shell?: string;
  signal?: AbortSignal;
}

export function execAsync(cmd: string, opts: ExecAsyncOptions = {}): Promise<string> {
  // Check abort before spawning to avoid unnecessary process creation
  if (opts.signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

    // Timeout
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 3000);
      }, opts.timeout);
    }

    // Abort signal
    if (opts.signal) {
      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 2000);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => opts.signal!.removeEventListener('abort', onAbort));
    }

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      // Check if aborted
      if (opts.signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }

      if (timedOut) {
        const err: any = new Error(`Command timed out after ${opts.timeout}ms`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      if (code !== 0) {
        const err: any = new Error(`Command failed with exit code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.status = code;
        reject(err);
        return;
      }

      resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// Path traversal protection
// ---------------------------------------------------------------------------

/**
 * Resolve a relative path against baseDir and verify it stays within bounds.
 * Throws if the resolved path escapes baseDir.
 */
export function assertSafePath(baseDir: string, relativePath: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal not allowed: ${relativePath}`);
  }
  return resolved;
}
