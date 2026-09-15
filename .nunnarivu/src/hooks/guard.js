// @ts-check
/**
 * PreToolUse hook for Bash (KR-13; architecture §4, §6 item 1; decision
 * NF-012): when the command force-pushes (`--force`, `-f`, a `+refspec`, or
 * `--force-with-lease` to any branch but `nunnarivu/state`), pushes to the
 * default branch, or deletes a branch, add context saying the kit's rules
 * forbid it and why. Context only; it never blocks: branch protection and
 * the proxy in front of the session are what enforce KR-13.
 *
 * Inert unless the repository is registered (registered.js).
 */
import { contextOutput, cwdOf, runAsScript } from './io.js';
import { isRegistered } from './registered.js';

const STATE_BRANCH = 'nunnarivu/state';
/** git options that take a value before the subcommand. */
const GIT_VALUED = new Set(['-c', '-C', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--config-env']);
/** push options that take a value. */
const PUSH_VALUED = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o', '--recurse-submodules']);

/**
 * @typedef {import('./io.js').HookInput} HookInput
 * @typedef {import('./io.js').HookContext} HookContext
 * @typedef {import('./io.js').HookOutput} HookOutput
 * @typedef {{ defaultBranch: string, currentBranch: string | null }} Refs
 */

/**
 * @param {HookInput} input
 * @param {HookContext} ctx
 * @returns {HookOutput | null}
 */
export function run(input, ctx) {
  try {
    const toolInput = input.tool_input;
    if (toolInput === null || typeof toolInput !== 'object') return null;
    const command = /** @type {Record<string, unknown>} */ (toolInput).command;
    if (typeof command !== 'string' || command === '') return null;
    const cwd = cwdOf(input);
    if (!isRegistered(cwd, ctx.readFile)) return null;
    const violations = findViolations(command, { defaultBranch: defaultBranch(ctx, cwd), currentBranch: currentBranch(ctx, cwd) });
    if (violations.length === 0) return null;
    return contextOutput('PreToolUse', violations.join(' '));
  } catch {
    return null;
  }
}

/**
 * The rules the command breaks, one message per rule, in the order force
 * push, default branch, deletion.
 *
 * @param {string} command a Bash command line
 * @param {Refs} refs
 * @returns {string[]}
 */
export function findViolations(command, refs) {
  let force = false;
  let toDefault = false;
  let deletes = false;
  for (const tokens of segments(command)) {
    const invocation = gitInvocation(tokens);
    if (invocation === null) continue;
    const { subcommand, args } = invocation;
    if (subcommand === 'push') {
      const push = analysePush(args, refs);
      force = force || push.force;
      toDefault = toDefault || push.toDefault;
      deletes = deletes || push.deletes;
    } else if (subcommand === 'branch') {
      deletes = deletes || args.some((a) => a === '--delete' || (/^-[a-zA-Z]+$/.test(a) && /[dD]/.test(a)));
    }
  }
  const messages = [];
  if (force) {
    messages.push(
      `The kit's rules forbid force-pushing: a package branch's history is what its review and the state branch's head refer to, and only the compare-and-swap push to ${STATE_BRANCH} uses --force-with-lease (KR-13).`,
    );
  }
  if (toDefault) {
    messages.push(
      `The kit's rules forbid pushing to the default branch ${refs.defaultBranch}: changes reach it only through a pull request that the trusted merge workflow merges after the gates pass (KR-13).`,
    );
  }
  if (deletes) {
    messages.push(
      'The kit\'s rules forbid deleting a branch from a session: the trusted merge workflow deletes a package branch after merging it (KR-13, decision NF-012).',
    );
  }
  return messages;
}

/**
 * @param {string[]} args the arguments after `push`
 * @param {Refs} refs
 */
function analysePush(args, refs) {
  let force = false;
  let lease = false;
  let deleteFlag = false;
  /** @type {string | null} */
  let leaseRef = null;
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a === '--force') force = true;
    else if (a === '--force-with-lease') lease = true;
    else if (a.startsWith('--force-with-lease=')) {
      lease = true;
      leaseRef = a.slice('--force-with-lease='.length).split(':')[0];
    } else if (a === '--delete') deleteFlag = true;
    else if (a.startsWith('--')) {
      if (PUSH_VALUED.has(a)) i += 1;
    } else if (a.startsWith('-') && a.length > 1) {
      const flags = a.slice(1);
      if (flags.includes('f')) force = true;
      if (flags.includes('d')) deleteFlag = true;
      if (PUSH_VALUED.has(a)) i += 1;
    } else positional.push(a);
  }
  const refspecs = positional.slice(1);
  /** @type {{ dst: string, deletes: boolean }[]} */
  const targets = [];
  for (const spec of refspecs) {
    if (deleteFlag) {
      targets.push({ dst: branchName(spec), deletes: true });
      continue;
    }
    let s = spec;
    if (s.startsWith('+')) {
      force = true;
      s = s.slice(1);
    }
    const colon = s.indexOf(':');
    if (colon === -1) targets.push({ dst: branchName(s), deletes: false });
    else targets.push({ dst: branchName(s.slice(colon + 1)), deletes: colon === 0 });
  }
  if (targets.length === 0) {
    const dst = leaseRef !== null && leaseRef !== '' ? branchName(leaseRef) : refs.currentBranch;
    if (dst !== null) targets.push({ dst, deletes: deleteFlag });
  }
  if (lease && targets.some((t) => t.dst !== STATE_BRANCH)) force = true;
  return {
    force,
    toDefault: targets.some((t) => !t.deletes && t.dst === refs.defaultBranch),
    deletes: targets.some((t) => t.deletes),
  };
}

/** @param {string} ref */
function branchName(ref) {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * The git subcommand a segment runs and its arguments, or null when the
 * segment is not a git command. Leading `VAR=value` assignments and git's
 * own options before the subcommand are skipped.
 *
 * @param {string[]} tokens
 * @returns {{ subcommand: string, args: string[] } | null}
 */
function gitInvocation(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (i >= tokens.length) return null;
  const program = tokens[i].split('/').pop();
  if (program !== 'git') return null;
  i += 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (GIT_VALUED.has(tokens[i])) i += 1;
    i += 1;
  }
  if (i >= tokens.length) return null;
  return { subcommand: tokens[i], args: tokens.slice(i + 1) };
}

/**
 * The command line as simple commands: split on `&&`, `||`, `;`, `|`, `&`
 * and newlines outside quotes, each tokenized on whitespace with quotes
 * removed. Good enough to see a `git push` for what it is; anything more
 * elaborate is the permission system's job, not a hook's.
 *
 * @param {string} command
 * @returns {string[][]}
 */
function segments(command) {
  /** @type {string[][]} */
  const result = [];
  /** @type {string[]} */
  let current = [];
  let token = '';
  let inToken = false;
  /** @type {string | null} */
  let quote = null;
  const endToken = () => {
    if (inToken) current.push(token);
    token = '';
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (current.length > 0) result.push(current);
    current = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else token += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (c === '\\' && i + 1 < command.length) {
      token += command[i + 1];
      inToken = true;
      i += 1;
    } else if ((c === '&' || c === '|') && command[i + 1] === c) {
      endSegment();
      i += 1;
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      endSegment();
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      token += c;
      inToken = true;
    }
  }
  endSegment();
  return result;
}

/** The branch `origin/HEAD` points at, else `main`. @param {HookContext} ctx @param {string} cwd */
function defaultBranch(ctx, cwd) {
  try {
    return ctx.git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/** The checked-out branch, or null when HEAD is detached. @param {HookContext} ctx @param {string} cwd */
function currentBranch(ctx, cwd) {
  try {
    return ctx.git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    return null;
  }
}

runAsScript(import.meta.url, run);
