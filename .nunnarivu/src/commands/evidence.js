// @ts-check
/**
 * `nunnarivu evidence check`: verifies the evidence a package branch carries
 * (KR-04). Loads `nunnarivu.yml` and the record's `evidence.json`
 * (`nunnarivu/wp-<issue>/`, NF-012), resolves the checker the configuration
 * names for the evidence's type, settles the base (`--base`, or the merge
 * base of HEAD and the default branch) and runs it. The package is `--issue`,
 * else the current one (`GITHUB_HEAD_REF` or the checked-out branch). Exit 0
 * when the evidence holds, 1 when it does not or cannot be checked, 2 on a
 * malformed command line.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../lib/config.js';
import { checkEvidence, decidingRun } from '../lib/evidence.js';
import { currentPackage } from '../lib/record.js';

export const EVIDENCE_USAGE = `Usage: nunnarivu evidence check [--repo <dir>] [--base <sha>] [--issue <n>] [--json]

Checks the package record's evidence.json with the checker nunnarivu.yml names for its type.

Options:
  --repo <dir>                   The repository (default: the current directory)
  --base <sha>                   The commit the implementation is compared with
                                 (default: the merge base of HEAD and the default branch)
  --issue <n>                    The package whose record holds the evidence
                                 (default: the current package, from GITHUB_HEAD_REF or the branch)
  --json                         Print the outcome as JSON
`;

/**
 * @typedef {import('../cli.js').Io} Io
 * @typedef {{
 *   cwd: string,
 *   timeoutMs: number,
 *   run: import('../lib/shell.js').Run,
 *   version: string,
 *   env: Record<string, string | undefined>,
 *   git: import('../lib/record.js').Git,
 * }} EvidenceContext
 */

/**
 * @param {string[]} args arguments after `evidence`
 * @param {EvidenceContext} ctx
 * @param {Io} io
 * @returns {Promise<number>}
 */
export async function runEvidence(args, ctx, io) {
  const [command, ...rest] = args;
  if (command !== 'check') {
    io.stderr.write(`${command === undefined ? 'evidence needs a command' : `Unknown evidence command: ${command}`}\n\n${EVIDENCE_USAGE}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { repo: { type: 'string' }, base: { type: 'string' }, issue: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${EVIDENCE_USAGE}`);
    return 2;
  }
  const given = parsed.values.issue;
  if (given !== undefined && !(/^[1-9][0-9]*$/.test(given) && Number.isSafeInteger(Number(given)))) {
    io.stderr.write(`--issue must be a positive integer, got ${given}\n\n${EVIDENCE_USAGE}`);
    return 2;
  }
  const repoDir = resolve(parsed.values.repo ?? ctx.cwd);
  const issue = given === undefined ? currentPackage(repoDir, ctx.env, ctx.git) : Number(given);
  if (issue === null) {
    io.stderr.write('no work package: give --issue or check out a claude/wp-<n> branch\n');
    return 1;
  }
  let config;
  try {
    config = loadConfig(repoDir);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  const outcome = await checkEvidence({ repoDir, issue, config, base: parsed.values.base, run: ctx.run, timeoutMs: ctx.timeoutMs });
  if (!outcome.ok) {
    io.stderr.write(`${outcome.reason}\n`);
    return 1;
  }
  const { result } = outcome;
  const code = result.status === 'pass' ? 0 : 1;
  if (parsed.values.json) {
    const { status, reason, before, after } = result;
    io.stdout.write(`${JSON.stringify({ version: ctx.version, type: outcome.type, checker: outcome.checker, base: outcome.base, status, reason, before, after }, null, 2)}\n`);
    return code;
  }
  io.stdout.write(`[${result.status}] evidence: ${outcome.type} (${outcome.checker}): ${result.reason}\n`);
  if (result.status === 'fail') {
    const run = decidingRun(result);
    io.stderr.write(`--- evidence failed ---\n${result.reason}\n`);
    if (outcome.command) io.stderr.write(`command: ${outcome.command}\n`);
    if (run.stdout_tail) io.stderr.write(`${run.stdout_tail}\n`);
    if (run.stderr_tail) io.stderr.write(`${run.stderr_tail}\n`);
  }
  return code;
}
