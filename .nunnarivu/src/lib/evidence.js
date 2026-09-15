// @ts-check
/**
 * Evidence (KR-04): `evidence.json` in the package record on its branch
 * (`nunnarivu/wp-<issue>/`, decision NF-012) names the package's tests, the
 * files they prove and an evidence type; `nunnarivu.yml` maps the type to a
 * checker. The one built-in checker,
 * `builtin:test-before-after`, shows that the tests pass with the
 * implementation and fail without it — in a temporary worktree of the
 * branch head, never in the caller's checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDir } from './record.js';
import { validate } from './schema.js';

/**
 * Where a package's record keeps its evidence, relative to the repository root.
 *
 * @param {number} issue
 * @returns {string} `nunnarivu/wp-<issue>/evidence.json`
 */
export function evidenceFile(issue) {
  return `${recordDir(issue)}/evidence.json`;
}

/** The built-in checker: tests pass with the implementation, fail without it. */
export const TEST_BEFORE_AFTER = 'builtin:test-before-after';

/** Placeholder in `commands.test_scoped` that the evidence's test files replace. */
export const TESTS_PLACEHOLDER = '{tests}';

/** Time budget of one test run when the caller sets none. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** @type {import('./schema.js').Schema} */
export const EVIDENCE_SCHEMA = Object.freeze(
  JSON.parse(readFileSync(new URL('../../schemas/evidence.schema.json', import.meta.url), 'utf8')),
);

/** Identity for the git commands the checker runs (it commits nothing, but never depends on the user's config). */
const KIT_IDENTITY = ['-c', 'user.name=nunnarivu', '-c', 'user.email=nunnarivu@noreply.invalid', '-c', 'commit.gpgsign=false'];

/**
 * A path segment safe to put into a shell command unquoted and to hand to
 * git: no whitespace, quotes or shell metacharacters.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_.@+,=:~-]+$/;

/**
 * @typedef {import('./shell.js').Run} Run
 * @typedef {import('./config.js').Config} Config
 * @typedef {{ schema: 1, issue: number, type: string, tests: string[], implementation: string[], notes: string }} Evidence
 * @typedef {{ exit_code: number | null, stdout_tail: string, stderr_tail: string }} RunSummary
 *
 * `before` is the run without the implementation (its files as at the base
 * commit), `after` the run with it — the names follow the type, not the
 * order the runs happen in. A run that did not happen has a null exit code
 * and empty tails.
 * @typedef {{ status: 'pass' | 'fail', reason: string, before: RunSummary, after: RunSummary }} CheckResult
 * @typedef {{ repoDir: string, base: string, evidence: Evidence, testScopedCommand: string, run: Run, timeoutMs?: number }} CheckInput
 * @typedef {(input: CheckInput) => Promise<CheckResult>} Checker
 * @typedef {{ repoDir: string, issue: number, config: Config, base?: string, run: Run, timeoutMs?: number }} CheckEvidenceInput
 * @typedef {{ ok: true, type: string, checker: string, base: string, command: string, result: CheckResult } | { ok: false, reason: string }} CheckEvidenceOutcome
 */

export class EvidenceError extends Error {
  /**
   * @param {string} file
   * @param {string[]} problems
   */
  constructor(file, problems) {
    super(problems.length === 1 ? `${file}: ${problems[0]}` : `${file}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'EvidenceError';
    this.file = file;
    this.problems = problems;
  }
}

/** The checkers the kit has, by the name `nunnarivu.yml` uses. @type {Readonly<Record<string, Checker>>} */
export const CHECKERS = Object.freeze({ [TEST_BEFORE_AFTER]: checkTestBeforeAfter });

/**
 * @param {string} repoDir
 * @param {number} issue
 * @returns {boolean} whether the package's record carries an evidence file
 */
export function hasEvidence(repoDir, issue) {
  return existsSync(join(repoDir, evidenceFile(issue)));
}

/**
 * Reads and validates the package's `evidence.json`; the evidence must name
 * the package whose record it sits in.
 *
 * @param {string} repoDir repository root
 * @param {number} issue the package
 * @returns {Evidence}
 * @throws {EvidenceError} listing every problem
 */
export function loadEvidence(repoDir, issue) {
  const file = join(repoDir, evidenceFile(issue));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    throw new EvidenceError(file, [code === 'ENOENT' ? 'not found' : String(/** @type {Error} */ (error).message)]);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new EvidenceError(file, [`not JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const problems = validate(EVIDENCE_SCHEMA, doc);
  if (problems.length > 0) throw new EvidenceError(file, problems);
  const valid = /** @type {Evidence} */ (doc);
  if (valid.issue !== issue) problems.push(`/issue: must be ${issue}, the package whose record holds this file`);
  for (const list of /** @type {const} */ (['tests', 'implementation'])) {
    valid[list].forEach((path, index) => {
      const problem = pathProblem(path);
      if (problem) problems.push(`/${list}/${index}: ${problem}`);
    });
  }
  if (problems.length > 0) throw new EvidenceError(file, problems);
  return {
    schema: 1,
    issue: valid.issue,
    type: valid.type,
    tests: [...valid.tests],
    implementation: [...valid.implementation],
    notes: valid.notes,
  };
}

/**
 * The checker `nunnarivu.yml` names for an evidence type, if the kit has it.
 *
 * @param {Config} config
 * @param {string} type
 * @returns {{ ok: true, checker: string } | { ok: false, reason: string }}
 */
export function resolveChecker(config, type) {
  const declared = config.evidence[type];
  if (!declared) {
    const types = Object.keys(config.evidence);
    return {
      ok: false,
      reason: `evidence type "${type}" is not declared in nunnarivu.yml (${types.length ? `declared: ${types.join(', ')}` : 'it declares none'})`,
    };
  }
  if (!Object.hasOwn(CHECKERS, declared.checker)) {
    return {
      ok: false,
      reason: `checker "${declared.checker}" for evidence type "${type}" is unknown (the kit has ${Object.keys(CHECKERS).join(', ')})`,
    };
  }
  return { ok: true, checker: declared.checker };
}

/**
 * Loads the evidence file, resolves its checker from the configuration,
 * settles the base commit and runs the checker. Problems before the check
 * can run come back as `ok: false`; the check's own verdict is in `result`.
 *
 * @param {CheckEvidenceInput} input
 * @returns {Promise<CheckEvidenceOutcome>}
 */
export async function checkEvidence({ repoDir, issue, config, base, run, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let evidence;
  try {
    evidence = loadEvidence(repoDir, issue);
  } catch (error) {
    if (error instanceof EvidenceError) return { ok: false, reason: error.message };
    throw error;
  }
  const resolved = resolveChecker(config, evidence.type);
  if (!resolved.ok) return resolved;
  let baseCommit;
  try {
    baseCommit = base === undefined ? defaultBase(repoDir) : resolveCommit(repoDir, base);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const testScopedCommand = config.commands.test_scoped;
  const result = await CHECKERS[resolved.checker]({ repoDir, base: baseCommit, evidence, testScopedCommand, run, timeoutMs });
  return {
    ok: true,
    type: evidence.type,
    checker: resolved.checker,
    base: baseCommit,
    command: scopedCommand(testScopedCommand, evidence.tests) ?? '',
    result,
  };
}

/**
 * `builtin:test-before-after` (KR-04): in a temporary worktree of the branch
 * head, the scoped test command must pass; then, with the implementation
 * files restored to their content at `base` (a file that did not exist there
 * is removed), the same command must fail. The worktree is removed whatever
 * happens.
 *
 * @type {Checker}
 */
export async function checkTestBeforeAfter({ repoDir, base, evidence, testScopedCommand, run, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  /** @type {RunSummary} */
  const none = { exit_code: null, stdout_tail: '', stderr_tail: '' };
  const command = scopedCommand(testScopedCommand, evidence.tests);
  if (command === null) {
    return { status: 'fail', reason: 'nunnarivu.yml declares no test_scoped command, so test-before-after cannot run', before: none, after: none };
  }
  const worktree = addWorktree(repoDir);
  try {
    const after = summarize(await run(command, worktree.dir, timeoutMs));
    if (after.exit_code !== 0) {
      return { status: 'fail', reason: `the tests fail with the implementation (${exitWord(after)})`, before: none, after };
    }
    restoreToBase(worktree.dir, base, evidence.implementation);
    const before = summarize(await run(command, worktree.dir, timeoutMs));
    if (before.exit_code === 0) {
      return { status: 'fail', reason: 'the tests pass without the implementation, so they prove nothing', before, after };
    }
    return { status: 'pass', reason: `the tests pass with the implementation and fail without it (${exitWord(before)})`, before, after };
  } finally {
    removeWorktree(repoDir, worktree);
  }
}

/**
 * The scoped test command for the evidence's tests: every `{tests}` in
 * `commands.test_scoped` becomes the test paths joined by spaces. A command
 * without the placeholder runs as written — the project scopes it itself.
 *
 * @param {string} testScopedCommand
 * @param {string[]} tests
 * @returns {string | null} null when the project declares no scoped command
 */
export function scopedCommand(testScopedCommand, tests) {
  if (testScopedCommand.trim() === '') return null;
  return testScopedCommand.split(TESTS_PLACEHOLDER).join(tests.join(' '));
}

/**
 * The merge base of HEAD and the default branch: `origin/HEAD` when the
 * clone records it; else the pull request's base branch when the CI
 * environment names one (`GITHUB_BASE_REF`), which must then exist; else
 * the first of origin/main, origin/master, main and master that exists.
 *
 * @param {string} repoDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} a full commit hash
 * @throws {Error} when no default branch or merge base can be found
 */
export function defaultBase(repoDir, env = process.env) {
  const ref = defaultBranchRef(repoDir, env);
  try {
    return git(repoDir, ['merge-base', 'HEAD', ref]);
  } catch (error) {
    throw new Error(`no merge base of HEAD and ${ref}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {string} repoDir
 * @param {string} ref anything git resolves to a commit
 * @returns {string} the full commit hash
 * @throws {Error} when it is not a commit of this repository
 */
export function resolveCommit(repoDir, ref) {
  try {
    return git(repoDir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new Error(`base "${ref}" is not a commit of this repository`);
  }
}

/** @param {string} repoDir @param {NodeJS.ProcessEnv} env */
function defaultBranchRef(repoDir, env) {
  try {
    const recorded = git(repoDir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
    if (recorded !== '') return recorded;
  } catch {
    // no origin/HEAD recorded
  }
  const named = env.GITHUB_BASE_REF;
  if (named) {
    const ref = `origin/${named}`;
    if (!isCommit(repoDir, ref)) throw new Error(`the base branch ${named} named by GITHUB_BASE_REF is not fetched as ${ref}`);
    return ref;
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (isCommit(repoDir, candidate)) return candidate;
  }
  throw new Error('cannot find the default branch: no origin/HEAD, GITHUB_BASE_REF, origin/main, origin/master, main or master');
}

/** @param {string} repoDir @param {string} ref */
function isCommit(repoDir, ref) {
  try {
    git(repoDir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {string | null} why the path cannot be used, or null
 */
function pathProblem(path) {
  if (path === '') return 'must not be empty';
  if (path.startsWith('/')) return 'must be relative to the repository root';
  if (path.startsWith('-')) return 'must not start with -';
  const segments = path.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return 'must not contain . or .. segments';
  if (segments.some((s) => !SAFE_SEGMENT.test(s))) return 'must contain only letters, digits and . _ - @ + , = : ~ (no spaces or quotes)';
  return null;
}

/** @typedef {{ root: string, dir: string }} Worktree */

/**
 * A detached worktree of HEAD in a fresh temporary directory.
 *
 * @param {string} repoDir
 * @returns {Worktree}
 */
function addWorktree(repoDir) {
  const root = mkdtempSync(join(tmpdir(), 'nunnarivu-evidence-'));
  const dir = join(root, 'worktree');
  try {
    git(repoDir, ['worktree', 'add', '-q', '--detach', dir, 'HEAD']);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, dir };
}

/**
 * Removes the worktree and its registration; never throws.
 *
 * @param {string} repoDir
 * @param {Worktree} worktree
 */
function removeWorktree(repoDir, worktree) {
  try {
    git(repoDir, ['worktree', 'remove', '-q', '--force', worktree.dir]);
  } catch {
    // removed below, then pruned
  }
  rmSync(worktree.root, { recursive: true, force: true });
  try {
    git(repoDir, ['worktree', 'prune']);
  } catch {
    // nothing left to prune
  }
}

/**
 * Puts the implementation files back as they were at `base`: checked out
 * from that commit where they existed there, removed where they did not.
 * An entry that is a directory at the base is checked out as one.
 *
 * @param {string} worktree
 * @param {string} base
 * @param {string[]} paths
 */
function restoreToBase(worktree, base, paths) {
  const atBase = git(worktree, ['ls-tree', '-r', '-z', '--name-only', base, '--', ...paths])
    .split('\0')
    .filter(Boolean);
  const existed = (/** @type {string} */ path) => atBase.some((file) => file === path || file.startsWith(`${path}/`));
  const present = paths.filter(existed);
  const absent = paths.filter((p) => !existed(p));
  if (present.length > 0) git(worktree, ['checkout', '-q', base, '--', ...present]);
  for (const path of absent) rmSync(join(worktree, path), { recursive: true, force: true });
}

/**
 * The run that decided a failed check: the one with the implementation when
 * it failed, else the one without it (which passed and so proved nothing).
 *
 * @param {CheckResult} result
 * @returns {RunSummary}
 */
export function decidingRun(result) {
  return result.after.exit_code !== 0 ? result.after : result.before;
}

/** @param {import('./shell.js').RunResult} result @returns {RunSummary} */
function summarize(result) {
  return { exit_code: result.exit_code, stdout_tail: result.stdout_tail, stderr_tail: result.stderr_tail };
}

/** @param {RunSummary} run */
function exitWord(run) {
  return run.exit_code === null ? 'stopped' : `exit ${run.exit_code}`;
}

/**
 * Runs git with the kit's identity; throws with stderr on failure.
 *
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  try {
    return execFileSync('git', [...KIT_IDENTITY, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const e = /** @type {{ stderr?: unknown, message?: string }} */ (error);
    throw new Error(`git ${args[0]} failed in ${cwd}: ${String(e.stderr ?? e.message ?? '').trim()}`);
  }
}
