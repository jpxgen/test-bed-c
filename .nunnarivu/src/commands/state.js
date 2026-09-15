// @ts-check
import { parseArgs } from 'node:util';

/**
 * @typedef {import('../cli.js').Io} Io
 * @typedef {import('../lib/state.js').TransitionRequest} TransitionRequest
 * @typedef {import('../lib/state.js').AnnotateRequest} AnnotateRequest
 * @typedef {import('../lib/state.js').StartRequest} StartRequest
 * @typedef {import('../lib/state-branch.js').UpdateOptions} UpdateOptions
 * @typedef {{
 *   cwd: string,
 *   now: () => Date,
 *   branch: {
 *     readState: typeof import('../lib/state-branch.js').readState,
 *     transition: typeof import('../lib/state-branch.js').transition,
 *     reconcile: typeof import('../lib/state-branch.js').reconcile,
 *     annotate: typeof import('../lib/state-branch.js').annotate,
 *     start: typeof import('../lib/state-branch.js').start,
 *   },
 * }} StateContext
 */

export const STATE_USAGE = `Usage: nunnarivu state <command> [options]

Commands:
  show [<issue>]                 Print the state, or one work package, as JSON
  transition <issue> --to <station>
      [--head <sha>] [--run <url>] [--claim <glob>]... [--lease-minutes <n>]
      [--reason <text>]          One atomic transition; prints the resulting record
                                 (--reason is required, and only allowed, for --to blocked)
  start <issue> --station <station> [--lease-minutes <n>]
                                 Mark the package waiting at the station as started: run_url
                                 becomes pending and the lease is renewed; prints the record
  annotate <issue> [--run <url>] [--head <sha>] [--done]
                                 Record the run link and/or head commit without moving the
                                 package, or (--done) that the session at this station ended
                                 without moving it; prints the resulting record
  reconcile                      Return started packages past their lease to ready; prints
                                 what changed

Options:
  --repo <dir>                   The repository (default: the current directory)
`;

class UsageError extends Error {}

/**
 * `nunnarivu state ...`: exit 0 on success, 1 when a transition is refused
 * or the branch cannot be read or written, 2 on a malformed command line.
 *
 * @param {string[]} args arguments after `state`
 * @param {StateContext} ctx
 * @param {Io} io
 * @returns {number}
 */
export function runState(args, ctx, io) {
  const [command, ...rest] = args;
  try {
    if (command === 'show') return show(rest, ctx, io);
    if (command === 'transition') return transition(rest, ctx, io);
    if (command === 'start') return start(rest, ctx, io);
    if (command === 'annotate') return annotate(rest, ctx, io);
    if (command === 'reconcile') return reconcile(rest, ctx, io);
    throw new UsageError(command === undefined ? 'state needs a command' : `Unknown state command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${STATE_USAGE}`);
      return 2;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** @param {string[]} args @param {StateContext} ctx @param {Io} io */
function show(args, ctx, io) {
  const { positionals, repo } = parse(args, {});
  if (positionals.length > 1) throw new UsageError('show takes at most one <issue>');
  const issue = positionals.length === 1 ? parseIssue(positionals[0]) : null;
  const { state } = ctx.branch.readState(repo ?? ctx.cwd);
  if (issue === null) {
    io.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  const pkg = state.packages[String(issue)];
  if (!pkg) {
    io.stderr.write(`no work package #${issue}\n`);
    return 1;
  }
  io.stdout.write(`${JSON.stringify(pkg, null, 2)}\n`);
  return 0;
}

/** @param {string[]} args @param {StateContext} ctx @param {Io} io */
function transition(args, ctx, io) {
  const { positionals, values, repo } = parse(args, {
    to: { type: 'string' },
    head: { type: 'string' },
    run: { type: 'string' },
    claim: { type: 'string', multiple: true },
    'lease-minutes': { type: 'string' },
    reason: { type: 'string' },
  });
  if (positionals.length !== 1 || !values.to) throw new UsageError('transition needs <issue> and --to <station>');
  /** @type {TransitionRequest} */
  const request = { issue: parseIssue(positionals[0]), to: /** @type {TransitionRequest['to']} */ (values.to) };
  if (values.head !== undefined) request.head = values.head;
  if (values.run !== undefined) request.run_url = values.run;
  if (values.claim !== undefined) request.claim = values.claim;
  if (values.reason !== undefined) request.reason = values.reason;
  if (values['lease-minutes'] !== undefined) {
    const minutes = Number(values['lease-minutes']);
    if (!Number.isFinite(minutes)) throw new UsageError(`--lease-minutes needs a number, got ${values['lease-minutes']}`);
    request.lease_minutes = minutes;
  }
  const result = ctx.branch.transition(repo ?? ctx.cwd, request, { now: ctx.now() });
  if (!result.ok) {
    io.stderr.write(`refused: ${result.reason}\n`);
    return 1;
  }
  io.stdout.write(`${JSON.stringify(result.state.packages[String(request.issue)], null, 2)}\n`);
  return 0;
}

/** @param {string[]} args @param {StateContext} ctx @param {Io} io */
function start(args, ctx, io) {
  const { positionals, values, repo } = parse(args, { station: { type: 'string' }, 'lease-minutes': { type: 'string' } });
  if (positionals.length !== 1 || !values.station) throw new UsageError('start needs <issue> and --station <station>');
  /** @type {StartRequest} */
  const request = { issue: parseIssue(positionals[0]), station: /** @type {StartRequest['station']} */ (values.station) };
  if (values['lease-minutes'] !== undefined) {
    const minutes = Number(values['lease-minutes']);
    if (!Number.isFinite(minutes)) throw new UsageError(`--lease-minutes needs a number, got ${values['lease-minutes']}`);
    request.lease_minutes = minutes;
  }
  const result = ctx.branch.start(repo ?? ctx.cwd, request, { now: ctx.now() });
  if (!result.ok) {
    io.stderr.write(`refused: ${result.reason}\n`);
    return 1;
  }
  io.stdout.write(`${JSON.stringify(result.state.packages[String(request.issue)], null, 2)}\n`);
  return 0;
}

/** @param {string[]} args @param {StateContext} ctx @param {Io} io */
function annotate(args, ctx, io) {
  const { positionals, values, repo } = parse(args, { head: { type: 'string' }, run: { type: 'string' }, done: { type: 'boolean' } });
  if (positionals.length !== 1) throw new UsageError('annotate needs <issue>');
  /** @type {AnnotateRequest} */
  const request = { issue: parseIssue(positionals[0]) };
  if (values.head !== undefined) request.head = values.head;
  if (values.run !== undefined) request.run_url = values.run;
  if (values.done === true) request.done = true;
  const result = ctx.branch.annotate(repo ?? ctx.cwd, request, { now: ctx.now() });
  if (!result.ok) {
    io.stderr.write(`refused: ${result.reason}\n`);
    return 1;
  }
  io.stdout.write(`${JSON.stringify(result.state.packages[String(request.issue)], null, 2)}\n`);
  return 0;
}

/** @param {string[]} args @param {StateContext} ctx @param {Io} io */
function reconcile(args, ctx, io) {
  const { positionals, repo } = parse(args, {});
  if (positionals.length > 0) throw new UsageError('reconcile takes no arguments');
  const result = ctx.branch.reconcile(repo ?? ctx.cwd, { now: ctx.now() });
  if (!result.ok) {
    io.stderr.write(`${result.reason}\n`);
    return 1;
  }
  io.stdout.write(`${JSON.stringify({ changes: result.changes }, null, 2)}\n`);
  return 0;
}

/**
 * @template {import('node:util').ParseArgsConfig['options']} O
 * @param {string[]} args
 * @param {O} options
 */
function parse(args, options) {
  try {
    const parsed = parseArgs({
      args,
      options: { ...options, repo: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
    const { repo, ...values } = /** @type {Record<string, any>} */ (parsed.values);
    return { positionals: parsed.positionals, values, repo: /** @type {string | undefined} */ (repo) };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** @param {string} text */
function parseIssue(text) {
  if (!/^\d+$/.test(text) || Number(text) === 0) throw new UsageError(`<issue> must be a positive integer, got ${text}`);
  return Number(text);
}
