// @ts-check
/**
 * `nunnarivu gate`: the binding CI gate (architecture §4; KR-04, KR-06).
 * Runs the project's `check` and `test` commands from `nunnarivu.yml`, one
 * gate each, then — when the checkout belongs to a package (`GITHUB_HEAD_REF`
 * or the checked-out branch is `claude/wp-<n>`, NF-012) whose record carries
 * `evidence.json` — the evidence check as a third gate, and passes only when
 * no gate failed. The trusted workflows run this; a fix skill reads its output.
 */
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { checkEvidence, decidingRun, hasEvidence } from '../lib/evidence.js';
import { currentPackage } from '../lib/record.js';

/**
 * @typedef {'pass' | 'fail' | 'skipped'} GateStatus
 * @typedef {{
 *   name: string,
 *   command: string,
 *   status: GateStatus,
 *   exit_code: number | null,
 *   duration_ms: number,
 *   stdout_tail: string,
 *   stderr_tail: string,
 * }} Gate
 * @typedef {{
 *   repo: string,
 *   timeoutMs: number,
 *   run: import('../lib/shell.js').Run,
 *   base?: string,
 *   env?: Record<string, string | undefined>,
 *   git?: import('../lib/record.js').Git,
 * }} GateContext
 *
 * `base` is the commit the evidence compares the implementation with; when
 * absent, the merge base of HEAD and the default branch. `env` and `git`
 * name the current package (the process environment and git by default).
 */

/** Configured commands that run as gates, in order. */
const COMMAND_GATES = /** @type {const} */ (['check', 'test']);

/**
 * Loads the repository's configuration and runs every gate. Each gate runs
 * regardless of the ones before it, so one run reports everything.
 *
 * @param {GateContext} ctx
 * @returns {Promise<Gate[]>}
 * @throws {import('../lib/config.js').ConfigError} when the configuration is missing or invalid
 */
export async function runGates(ctx) {
  const config = loadConfig(ctx.repo);
  /** @type {Gate[]} */
  const gates = [];
  for (const name of COMMAND_GATES) {
    gates.push(await runCommandGate(name, config.commands[name], ctx));
  }
  const issue = currentPackage(ctx.repo, ctx.env ?? process.env, ctx.git ?? gitOutput);
  if (issue !== null && hasEvidence(ctx.repo, issue)) gates.push(await runEvidenceGate(config, issue, ctx));
  return gates;
}

/**
 * @param {Gate[]} gates
 * @returns {number} 0 when no gate failed, 1 otherwise
 */
export function exitCodeFor(gates) {
  return gates.some((g) => g.status === 'fail') ? 1 : 0;
}

/**
 * @param {string} name
 * @param {string} command empty means the project has no such command
 * @param {GateContext} ctx
 * @returns {Promise<Gate>}
 */
async function runCommandGate(name, command, ctx) {
  if (command.trim() === '') {
    return { name, command, status: 'skipped', exit_code: null, duration_ms: 0, stdout_tail: '', stderr_tail: '' };
  }
  const started = Date.now();
  const result = await ctx.run(command, ctx.repo, ctx.timeoutMs);
  return {
    name,
    command,
    status: result.exit_code === 0 && !result.timed_out ? 'pass' : 'fail',
    exit_code: result.exit_code,
    duration_ms: Date.now() - started,
    stdout_tail: result.stdout_tail,
    stderr_tail: result.stderr_tail,
  };
}

/**
 * The evidence gate (KR-04): the same check as `nunnarivu evidence check`.
 * An evidence file that cannot be checked (invalid, or naming a type or
 * checker the configuration does not have) fails the gate without running
 * anything.
 *
 * @param {import('../lib/config.js').Config} config
 * @param {number} issue the package whose record holds the evidence
 * @param {GateContext} ctx
 * @returns {Promise<Gate>}
 */
async function runEvidenceGate(config, issue, ctx) {
  const name = 'evidence';
  const started = Date.now();
  const outcome = await checkEvidence({ repoDir: ctx.repo, issue, config, base: ctx.base, run: ctx.run, timeoutMs: ctx.timeoutMs });
  const duration_ms = Date.now() - started;
  if (!outcome.ok) {
    return { name, command: '', status: 'fail', exit_code: null, duration_ms, stdout_tail: '', stderr_tail: outcome.reason };
  }
  const { result } = outcome;
  const summary = `${outcome.type} (${outcome.checker}): ${result.reason}`;
  if (result.status === 'pass') {
    return { name, command: outcome.command, status: 'pass', exit_code: 0, duration_ms, stdout_tail: summary, stderr_tail: '' };
  }
  const run = decidingRun(result);
  const stderrTail = run.stderr_tail === '' ? `[nunnarivu] ${summary}` : `${run.stderr_tail}\n[nunnarivu] ${summary}`;
  return { name, command: outcome.command, status: 'fail', exit_code: 1, duration_ms, stdout_tail: run.stdout_tail, stderr_tail: stderrTail };
}

/**
 * Runs a read-only git command in a repository and returns its output; throws
 * when it fails.
 *
 * @type {import('../lib/record.js').Git}
 */
function gitOutput(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
