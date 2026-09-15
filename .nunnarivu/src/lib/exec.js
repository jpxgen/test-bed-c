// @ts-check
import { execFileSync } from 'node:child_process';

/**
 * @typedef {{ ok: boolean, stdout: string, stderr: string, code: number | null }} ExecResult
 * @typedef {(file: string, args: string[]) => ExecResult} Exec
 */

/**
 * Runs a program without a shell and never throws.
 *
 * @type {Exec}
 */
export function exec(file, args) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim(), stderr: '', code: 0 };
  } catch (error) {
    const e = /** @type {{ stdout?: unknown, stderr?: unknown, status?: number | null }} */ (error);
    return {
      ok: false,
      stdout: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? '').trim(),
      code: e.status ?? null,
    };
  }
}
