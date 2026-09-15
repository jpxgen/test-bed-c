// @ts-check
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {{ exit_code: number | null, timed_out: boolean, stdout_tail: string, stderr_tail: string }} RunResult
 * @typedef {(command: string, cwd: string, timeoutMs: number) => Promise<RunResult>} Run
 */

/** Lines of output kept from each stream. */
export const TAIL_LINES = 40;

/**
 * Runs a project command through `/bin/sh -c` in `cwd` with a time budget.
 * Output goes to files, not pipes, so a process that outlives the shell
 * cannot hold the caller open; the command runs in its own process group
 * so that a timeout kills everything it started. Never throws: a command
 * that cannot start reports `exit_code: null` and the reason on stderr.
 *
 * @type {Run}
 */
export async function runShell(command, cwd, timeoutMs) {
  const logDir = mkdtempSync(join(tmpdir(), 'nunnarivu-run-'));
  const outPath = join(logDir, 'stdout');
  const errPath = join(logDir, 'stderr');
  const out = openSync(outPath, 'w');
  const err = openSync(errPath, 'w');
  try {
    const run = await spawnShell(command, cwd, [out, err], timeoutMs);
    closeSync(out);
    closeSync(err);
    let stderrTail = tail(errPath);
    if (run.timedOut) stderrTail = appendLine(stderrTail, `[nunnarivu] timed out after ${timeoutMs} ms and was stopped`);
    else if (run.error) stderrTail = appendLine(stderrTail, `[nunnarivu] could not run the command: ${run.error}`);
    else if (run.code === null) stderrTail = appendLine(stderrTail, `[nunnarivu] the command was killed by ${run.signal}`);
    return { exit_code: run.timedOut ? null : run.code, timed_out: run.timedOut, stdout_tail: tail(outPath), stderr_tail: stderrTail };
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {[number, number]} fds stdout and stderr file descriptors
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, timedOut: boolean, error: string | null }>}
 */
function spawnShell(command, cwd, [out, err], timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', out, err], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, error: error.message });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) killGroup(child.pid);
      resolve({ code, signal, timedOut, error: null });
    });
  });
}

/** @param {number | undefined} pid */
function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** @param {string} path */
function tail(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  return text.replace(/\n$/, '').split('\n').slice(-TAIL_LINES).join('\n');
}

/** @param {string} text @param {string} line */
function appendLine(text, line) {
  return text === '' ? line : `${text}\n${line}`;
}
