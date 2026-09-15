// @ts-check
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, ConfigError, parseConfig } from '../lib/config.js';
import { ALLOWED, planDispatch } from '../lib/dispatch.js';
import { packageBranch, recordDir } from '../lib/record.js';

/**
 * `nunnarivu dispatch plan`: the deterministic half of the dispatch routine
 * (architecture §1; NF-012; KR-08, KR-11). It reads the capacity from
 * `nunnarivu.yml`, the state from the state branch and, for each package
 * waiting at review, the record from the package branch, and prints what
 * the routine should start, what runs, what waits and whether work is
 * paused. It never starts anything: `nunnarivu run` and the session tool
 * do that.
 */

/**
 * @typedef {import('../cli.js').Io} Io
 * @typedef {import('../lib/dispatch.js').Plan} Plan
 * @typedef {{
 *   cwd: string,
 *   readFile: (path: string) => string | null,
 *   git: (cwd: string, args: string[]) => string,
 *   branch: { readState: typeof import('../lib/state-branch.js').readState },
 * }} DispatchContext
 */

export const DISPATCH_USAGE = `Usage: nunnarivu dispatch plan [options]

Plans one dispatch round from the configuration (capacity.parallel), the state
branch and the package records: which sessions to start (station and skill),
which packages run, which wait for the trusted-merge workflow, and whether
work is paused by the rate limit. Starts nothing.

Options:
  --repo <dir>                   The repository (default: the current directory)
  --rate-limit <status>          The session's rate-limit status as get_session reports it
                                 (default: allowed; anything else pauses the starts)
  --json                         Print the plan as JSON
`;

class UsageError extends Error {}

/**
 * Exit 0 with the plan printed, 1 on a configuration or state error (the
 * reason on stderr), 2 on a malformed command line.
 *
 * @param {string[]} args arguments after `dispatch`
 * @param {DispatchContext} ctx
 * @param {Io} io
 * @returns {number}
 */
export function runDispatch(args, ctx, io) {
  try {
    const options = parse(args);
    const repo = options.repo === undefined ? ctx.cwd : resolve(ctx.cwd, options.repo);
    const plan = planDispatch({
      state: ctx.branch.readState(repo).state,
      capacity: capacityOf(repo, ctx),
      records: (issue) => recordFiles(repo, issue, ctx),
      rateLimit: options.rateLimit,
    });
    io.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : formatPlan(plan));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${DISPATCH_USAGE}`);
      return 2;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * The plan as text: a summary line, one line per start
 * (`start #<n> <station> <skill>`), per running package and per waiting
 * package, then `paused: ...` when paused.
 *
 * @param {Plan} plan
 */
export function formatPlan(plan) {
  const lines = [`capacity ${plan.capacity}, in flight ${plan.in_flight}, done ${plan.done}, blocked ${plan.blocked}`];
  for (const s of plan.starts) lines.push(`start #${s.issue} ${s.station} ${s.skill}`);
  for (const r of plan.running) lines.push(`running #${r.issue} ${r.station} ${r.run_url} (lease until ${r.lease_expires_at ?? 'none'})`);
  for (const w of plan.waiting) lines.push(`waiting #${w.issue} ${w.station}`);
  if (plan.paused !== null) lines.push(`paused: ${plan.paused}`);
  return `${lines.join('\n')}\n`;
}

/**
 * `capacity.parallel` of the repository's `nunnarivu.yml`; a missing or
 * invalid file is a configuration error.
 *
 * @param {string} repo
 * @param {DispatchContext} ctx
 */
function capacityOf(repo, ctx) {
  const file = join(repo, CONFIG_FILE);
  const text = ctx.readFile(file);
  if (text === null) throw new ConfigError(file, ['not found']);
  return parseConfig(text, file).capacity.parallel;
}

/**
 * The record's file names on the package branch, relative to
 * `nunnarivu/wp-<issue>/`: the branch is fetched from origin into its
 * remote-tracking ref (so a stale checkout still sees the latest round) and
 * listed with `ls-tree`. An absent branch has no files.
 *
 * @param {string} repo
 * @param {number} issue
 * @param {DispatchContext} ctx
 * @returns {string[]}
 */
function recordFiles(repo, issue, ctx) {
  const branch = packageBranch(issue);
  const ref = `refs/heads/${branch}`;
  if (ctx.git(repo, ['ls-remote', '--heads', 'origin', ref]).trim() === '') return [];
  ctx.git(repo, ['fetch', '-q', 'origin', `+${ref}:refs/remotes/origin/${branch}`]);
  const prefix = `${recordDir(issue)}/`;
  return ctx
    .git(repo, ['ls-tree', '-r', '--name-only', `origin/${branch}`, '--', prefix])
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/**
 * @param {string[]} args
 * @returns {{ repo: string | undefined, rateLimit: string, json: boolean }}
 */
function parse(args) {
  const [command, ...rest] = args;
  if (command !== 'plan') throw new UsageError(command === undefined ? 'dispatch needs a command' : `Unknown dispatch command: ${command}`);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { repo: { type: 'string' }, 'rate-limit': { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length > 0) throw new UsageError(`plan takes no arguments, got ${parsed.positionals.join(' ')}`);
  const rateLimit = parsed.values['rate-limit'] ?? ALLOWED;
  if (rateLimit.trim() === '') throw new UsageError('--rate-limit needs a status');
  return { repo: parsed.values.repo, rateLimit, json: parsed.values.json === true };
}
