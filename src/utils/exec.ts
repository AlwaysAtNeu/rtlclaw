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
      // New process group so timeout/abort can reap the whole tree
      // (shell + descendants) via process.kill(-pid, …).
      detached: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killHandle:    ReturnType<typeof setTimeout> | undefined;

    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (typeof child.pid === 'number') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* ESRCH: group already gone */ }
    };

    const scheduleEscalation = (): void => {
      if (killHandle) return;          // already escalating
      killGroup('SIGTERM');
      killHandle = setTimeout(() => {
        killGroup('SIGKILL');
        try { child.stdout?.destroy(); } catch { /* */ }
        try { child.stderr?.destroy(); } catch { /* */ }
      }, 3000);
    };

    if (opts.timeout && opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        scheduleEscalation();
      }, opts.timeout);
    }

    let onAbort: (() => void) | undefined;
    if (opts.signal) {
      onAbort = () => scheduleEscalation();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle)    clearTimeout(killHandle);
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

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
