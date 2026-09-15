// @ts-check
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyAnnotation, applyStart, applyTransition, expireLeases, fromFiles, toFiles } from './state.js';

/**
 * Reads and writes the orphan branch that is the source of truth for
 * work-package state (architecture §2, decision NF-003, KR-09).
 *
 * Every operation runs inside a temporary bare repository: the branch is
 * fetched from the caller's `origin`, a commit is built with git plumbing
 * (no working tree, no index of the caller's), and pushed with
 * `--force-with-lease=<ref>:<expected tip>` — a compare-and-swap. The
 * caller's checkout is never touched, not even its refs.
 */

export const STATE_BRANCH = 'nunnarivu/state';
const STATE_REF = `refs/heads/${STATE_BRANCH}`;
const REMOTE = 'origin';
const DEFAULT_MAX_RETRIES = 3;

/** Identity of the commits the kit writes on the state branch. */
const KIT_IDENTITY = ['-c', 'user.name=nunnarivu', '-c', 'user.email=nunnarivu@noreply.invalid', '-c', 'commit.gpgsign=false'];

/**
 * @typedef {import('./state.js').State} State
 * @typedef {import('./state.js').TransitionRequest} TransitionRequest
 * @typedef {import('./state.js').AnnotateRequest} AnnotateRequest
 * @typedef {import('./state.js').StartRequest} StartRequest
 * @typedef {import('./state.js').LeaseChange} LeaseChange
 * @typedef {{ state: State, tip: string | null }} ReadResult
 * @typedef {{ ok: true, tip: string } | { ok: false, reason: string }} WriteResult
 * @typedef {{ now?: Date, maxRetries?: number, afterRead?: (attempt: number) => void }} UpdateOptions
 * @typedef {{ ok: true, state: State, tip: string, attempts: number } | { ok: false, reason: string }} TransitionOutcome
 * @typedef {{ ok: true, state: State, tip: string | null, changes: LeaseChange[] } | { ok: false, reason: string }} ReconcileOutcome
 */

/**
 * Fetches the state branch of the repository's origin and parses it. An
 * absent branch reads as the empty state with a null tip.
 *
 * @param {string} repoDir a checkout whose `origin` holds the state branch
 * @returns {ReadResult}
 */
export function readState(repoDir) {
  return withScratch(repoDir, (scratch) => fetchState(scratch));
}

/**
 * Writes the state as one commit on top of `expectedTip` and pushes it with
 * a lease on that tip (null: the branch must not exist yet, and the commit
 * is an orphan). Files on the branch outside the model are kept. A push the
 * remote rejects because the tip moved returns `ok: false`; any other git
 * failure throws.
 *
 * @param {string} repoDir
 * @param {State} state
 * @param {string | null} expectedTip
 * @param {string} message commit message
 * @returns {WriteResult}
 */
export function writeState(repoDir, state, expectedTip, message) {
  return withScratch(repoDir, (scratch) => {
    if (expectedTip !== null) {
      const fetched = fetchState(scratch);
      if (fetched.tip !== expectedTip) {
        return { ok: false, reason: `${STATE_BRANCH} changed: expected ${expectedTip}, found ${fetched.tip ?? 'no branch'}` };
      }
    }
    const commit = buildCommit(scratch, state, expectedTip, message);
    return push(scratch, commit, expectedTip);
  });
}

/**
 * Read → applyTransition → write, retrying on a rejected push: the fresh
 * state is re-read and the guard re-applied, up to `maxRetries` times.
 *
 * @param {string} repoDir
 * @param {TransitionRequest} request
 * @param {UpdateOptions} [options]
 * @returns {TransitionOutcome}
 */
export function transition(repoDir, request, options = {}) {
  const outcome = update(
    repoDir,
    (state, now) => {
      const result = applyTransition(state, request, now);
      if (!result.ok) return result;
      const before = state.packages[String(request.issue)];
      const from = before ? `${before.station} ` : '';
      const claims = request.claim?.length ? `, claims ${request.claim.join(' ')}` : '';
      const attempt = result.state.packages[String(request.issue)].attempt;
      return { ok: true, state: result.state, message: `transition #${request.issue} ${from}-> ${request.to} (attempt ${attempt})${claims}` };
    },
    options,
  );
  if (!outcome.ok) return outcome;
  return { ok: true, state: outcome.state, tip: /** @type {string} */ (outcome.tip), attempts: outcome.attempts };
}

/**
 * Marks a package waiting at a station as started (NF-012) as one commit:
 * `run_url` becomes `pending` and the lease is renewed; same
 * compare-and-swap loop as a transition, so two dispatchers cannot start
 * two sessions for one package.
 *
 * @param {string} repoDir
 * @param {StartRequest} request
 * @param {UpdateOptions} [options]
 * @returns {TransitionOutcome}
 */
export function start(repoDir, request, options = {}) {
  const outcome = update(
    repoDir,
    (state, now) => {
      const result = applyStart(state, request, now);
      if (!result.ok) return result;
      const attempt = result.state.packages[String(request.issue)].attempt;
      return { ok: true, state: result.state, message: `start #${request.issue} at ${request.station} (attempt ${attempt})` };
    },
    options,
  );
  if (!outcome.ok) return outcome;
  return { ok: true, state: outcome.state, tip: /** @type {string} */ (outcome.tip), attempts: outcome.attempts };
}

/**
 * Records a package's run link and/or head, or that its session is done,
 * as one commit, leaving its station and lease alone; same compare-and-swap
 * loop as a transition.
 *
 * @param {string} repoDir
 * @param {AnnotateRequest} request
 * @param {UpdateOptions} [options]
 * @returns {TransitionOutcome}
 */
export function annotate(repoDir, request, options = {}) {
  const outcome = update(
    repoDir,
    (state, now) => {
      const result = applyAnnotation(state, request, now);
      if (!result.ok) return result;
      const parts = [];
      if (request.head !== undefined) parts.push(`head ${request.head}`);
      if (request.run_url !== undefined) parts.push(`run ${request.run_url}`);
      if (request.done === true) parts.push('done');
      return { ok: true, state: result.state, message: `annotate #${request.issue}: ${parts.join(', ')}` };
    },
    options,
  );
  if (!outcome.ok) return outcome;
  return { ok: true, state: outcome.state, tip: /** @type {string} */ (outcome.tip), attempts: outcome.attempts };
}

/**
 * Returns every started package past its lease to ready (KR-10, NF-012) and
 * writes the result as one commit; writes nothing when no lease has expired.
 *
 * @param {string} repoDir
 * @param {UpdateOptions} [options]
 * @returns {ReconcileOutcome}
 */
export function reconcile(repoDir, options = {}) {
  /** @type {LeaseChange[]} */
  let changes = [];
  const outcome = update(
    repoDir,
    (state, now) => {
      const expired = expireLeases(state, now);
      changes = expired.changes;
      if (changes.length === 0) return { ok: true, state, message: null };
      const summary = changes.map((c) => `#${c.issue} ${c.from} -> ${c.to} (attempt ${c.attempt})`).join(', ');
      return { ok: true, state: expired.state, message: `reconcile: ${summary}` };
    },
    options,
  );
  if (!outcome.ok) return outcome;
  return { ok: true, state: outcome.state, tip: outcome.tip, changes };
}

/**
 * The compare-and-swap loop shared by transition, start, annotate and reconcile. A step
 * returning a null message has nothing to write.
 *
 * @param {string} repoDir
 * @param {(state: State, now: Date) => { ok: true, state: State, message: string | null } | { ok: false, reason: string }} step
 * @param {UpdateOptions} options
 * @returns {{ ok: true, state: State, tip: string | null, attempts: number } | { ok: false, reason: string }}
 */
function update(repoDir, step, { now = new Date(), maxRetries = DEFAULT_MAX_RETRIES, afterRead } = {}) {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const { state, tip } = readState(repoDir);
    afterRead?.(attempt);
    const result = step(state, now);
    if (!result.ok) return result;
    if (result.message === null) return { ok: true, state, tip, attempts: attempt };
    const written = writeState(repoDir, result.state, tip, result.message);
    if (written.ok) return { ok: true, state: result.state, tip: written.tip, attempts: attempt };
  }
  return { ok: false, reason: `${STATE_BRANCH} kept changing under us; gave up after ${maxRetries} retries` };
}

/**
 * Runs `work` inside a fresh bare repository that knows the caller's origin
 * URL, and removes it afterwards.
 *
 * @template T
 * @param {string} repoDir
 * @param {(scratch: Scratch) => T} work
 * @returns {T}
 */
function withScratch(repoDir, work) {
  const url = git(repoDir, ['remote', 'get-url', REMOTE]);
  const dir = mkdtempSync(join(tmpdir(), 'nunnarivu-state-'));
  try {
    git(dir, ['init', '-q', '--bare']);
    return work({ dir, url });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @typedef {{ dir: string, url: string }} Scratch */

/**
 * @param {Scratch} scratch
 * @returns {ReadResult}
 */
function fetchState(scratch) {
  const listed = git(scratch.dir, ['ls-remote', '--', scratch.url, STATE_REF]);
  if (listed === '') return { state: fromFiles({}), tip: null };
  git(scratch.dir, ['fetch', '-q', '--', scratch.url, STATE_REF]);
  const tip = git(scratch.dir, ['rev-parse', 'FETCH_HEAD']);
  return { state: fromFiles(readFiles(scratch.dir, tip)), tip };
}

/**
 * The model's files at a commit, read in one `cat-file --batch` call.
 *
 * @param {string} dir
 * @param {string} commit
 * @returns {Record<string, string>}
 */
function readFiles(dir, commit) {
  const entries = git(dir, ['ls-tree', '-r', '-z', commit])
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [, type, blob] = meta.split(' ');
      return { type, blob, path };
    })
    .filter((e) => e.type === 'blob' && (e.path === 'locks.json' || /^wp\/\d+\.json$/.test(e.path)));
  if (entries.length === 0) return {};
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: dir,
    input: `${entries.map((e) => e.blob).join('\n')}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  /** @type {Record<string, string>} */
  const files = {};
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = batch.indexOf('\n', offset);
    const header = batch.subarray(offset, headerEnd).toString('utf8');
    const size = Number(header.split(' ')[2]);
    if (!Number.isInteger(size)) throw new Error(`unexpected cat-file header for ${entry.path}: ${header}`);
    files[entry.path] = batch.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8');
    offset = headerEnd + 1 + size + 1;
  }
  return files;
}

/**
 * Builds one commit holding the state's files over the parent's tree, with
 * plumbing only: a private index, `hash-object`, `update-index`,
 * `write-tree`, `commit-tree`.
 *
 * @param {Scratch} scratch
 * @param {State} state
 * @param {string | null} parent
 * @param {string} message
 * @returns {string} the commit hash
 */
function buildCommit(scratch, state, parent, message) {
  const files = toFiles(state);
  const paths = Object.keys(files).sort();
  const stage = join(scratch.dir, 'stage');
  for (const path of paths) {
    mkdirSync(dirname(join(stage, path)), { recursive: true });
    writeFileSync(join(stage, path), files[path]);
  }
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch.dir, 'index') };
  if (parent !== null) git(scratch.dir, ['read-tree', parent], env);
  const blobs = git(scratch.dir, ['hash-object', '-w', '--stdin-paths'], env, `${paths.map((p) => join(stage, p)).join('\n')}\n`).split('\n');
  const index = paths.map((path, i) => `100644 ${blobs[i]}\t${path}`).join('\n');
  git(scratch.dir, ['update-index', '--add', '--index-info'], env, `${index}\n`);
  const tree = git(scratch.dir, ['write-tree'], env);
  const args = ['commit-tree', tree, '-m', message];
  if (parent !== null) args.push('-p', parent);
  return git(scratch.dir, args, env);
}

/**
 * @param {Scratch} scratch
 * @param {string} commit
 * @param {string | null} expectedTip
 * @returns {WriteResult}
 */
function push(scratch, commit, expectedTip) {
  try {
    execFileSync(
      'git',
      ['push', '-q', `--force-with-lease=${STATE_REF}:${expectedTip ?? ''}`, '--', scratch.url, `${commit}:${STATE_REF}`],
      { cwd: scratch.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, tip: commit };
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? '');
    if (/stale info|\[rejected\]|fetch first/.test(stderr)) {
      return { ok: false, reason: `${STATE_BRANCH} changed: the push on ${expectedTip ?? 'a new branch'} was rejected` };
    }
    throw new Error(`git push of ${STATE_BRANCH} failed: ${stderr.trim()}`);
  }
}

/**
 * Runs git with the kit's identity; throws with stderr on failure.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [input]
 */
function git(cwd, args, env = process.env, input) {
  try {
    return execFileSync('git', [...KIT_IDENTITY, ...args], {
      cwd,
      env,
      input,
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const e = /** @type {{ stderr?: unknown, message?: string }} */ (error);
    throw new Error(`git ${args[0]} failed in ${cwd}: ${String(e.stderr ?? e.message ?? '').trim()}`);
  }
}
