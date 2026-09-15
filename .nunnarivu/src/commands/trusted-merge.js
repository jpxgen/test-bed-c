// @ts-check
/**
 * Trusted merge decider — the merge station (architecture §6 items 2–3;
 * KR-13, KR-15; decision NF-012).
 *
 * Runs in the trusted workflow on the default branch and never checks out
 * pull-request code. Every fact comes from the GitHub API through the
 * injected `gh` runner and from the state branch through the injected
 * reader; every refusal reason is collected before deciding; any gh
 * failure, unreadable state or unexpected answer fails closed with exit
 * code 2. A merged package's pull request is merged with its head branch
 * deleted, and the package moves to cleanup with the merge commit.
 */
import { packageFromBranch } from '../lib/record.js';

/**
 * @typedef {import('../lib/exec.js').ExecResult} ExecResult
 * @typedef {(args: string[]) => ExecResult} Runner
 * @typedef {{
 *   gh: Runner,
 *   git: Runner,
 *   env: Record<string, string | undefined>,
 *   now?: Date,
 *   state: {
 *     readState: typeof import('../lib/state-branch.js').readState,
 *     transition: typeof import('../lib/state-branch.js').transition,
 *   },
 * }} MergeContext
 * @typedef {{ pr: number | null, head: string, require: string[], repoDir: string }} MergeOptions
 * @typedef {{ decision: 'merge' | 'refuse', pr: number | null, head: string, reasons: string[] }} Report
 *   a `merge` report with reasons means the merge happened but the package
 *   could not be moved to cleanup (exit code 2; reconcile repairs the state)
 * @typedef {{ code: 0 | 1 | 2, report: Report }} MergeResult
 * @typedef {{ owner: string, repo: string }} Origin
 * @typedef {{ ok: true, json: boolean, options: MergeOptions } | { ok: false, error: string }} ParsedArgs
 */

/** The check that must have succeeded when `--require` is not given. */
export const DEFAULT_REQUIRED = Object.freeze(['gates']);

/**
 * Paths a pull request may not touch on its way through the trusted merge:
 * workflows, Claude Code configuration, and the gate configuration with the
 * kit pin (architecture §6 item 2 and §9). The owner merges those by hand.
 */
export const PROTECTED_DIRS = Object.freeze(['.github', '.claude']);
export const PROTECTED_FILES = Object.freeze(['nunnarivu.yml']);

/** Check-run conclusions that do not stand in the way of a merge. */
const HARMLESS = new Set(['success', 'neutral', 'skipped']);

const SHA = /^[0-9a-f]{40}$/;
const NUMBER = /^[1-9][0-9]*$/;
const PAGE = '?per_page=100';

/**
 * Raised for a gh failure or an answer that is not the expected shape.
 * Never a pass: the caller turns it into a reason and exit code 2.
 */
class GhFailure extends Error {}

/**
 * @param {string[]} argv arguments after `trusted-merge`
 * @param {string} cwd default repository directory
 * @returns {ParsedArgs}
 */
export function parseTrustedMergeArgs(argv, cwd) {
  /** @type {string | undefined} */ let pr;
  /** @type {string | undefined} */ let head;
  /** @type {string | undefined} */ let repoDir;
  /** @type {string[]} */ const require = [];
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg !== '--pr' && arg !== '--head' && arg !== '--require' && arg !== '--repo') {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { ok: false, error: `${arg} needs a value` };
    }
    i += 1;
    if (arg === '--require') {
      require.push(value);
    } else if (arg === '--pr') {
      if (pr !== undefined) return { ok: false, error: '--pr given twice' };
      pr = value;
    } else if (arg === '--head') {
      if (head !== undefined) return { ok: false, error: '--head given twice' };
      head = value;
    } else {
      if (repoDir !== undefined) return { ok: false, error: '--repo given twice' };
      repoDir = value;
    }
  }

  if (pr !== undefined && !NUMBER.test(pr)) return { ok: false, error: `--pr must be a positive integer, not "${pr}"` };
  if (head === undefined) return { ok: false, error: '--head <sha> is required' };
  if (!SHA.test(head)) {
    return { ok: false, error: `--head must be a full lowercase 40-hex commit sha, not "${head}"` };
  }
  return {
    ok: true,
    json,
    options: {
      pr: pr === undefined ? null : Number(pr),
      head,
      require: require.length > 0 ? require : [...DEFAULT_REQUIRED],
      repoDir: repoDir ?? cwd,
    },
  };
}

/**
 * Owner and repository from a GitHub origin URL in https or ssh form.
 *
 * @param {string} url
 * @returns {Origin | null}
 */
export function parseOrigin(url) {
  const name = '([A-Za-z0-9_.-]+)';
  const forms = [
    new RegExp(`^https?://(?:[^@/]+@)?github\\.com/${name}/${name}/?$`),
    new RegExp(`^ssh://(?:[^@/]+@)?github\\.com(?::[0-9]+)?/${name}/${name}/?$`),
    new RegExp(`^(?:[^@/]+@)?github\\.com:${name}/${name}$`),
  ];
  for (const form of forms) {
    const m = form.exec(url.trim());
    if (!m) continue;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');
    if (owner === '.' || owner === '..' || repo === '' || repo === '.' || repo === '..') return null;
    return { owner, repo };
  }
  return null;
}

/**
 * Decides, and merges when nothing refuses.
 *
 * @param {MergeContext} ctx
 * @param {MergeOptions} options
 * @returns {MergeResult}
 */
export function runTrustedMerge(ctx, options) {
  const { head } = options;
  /** @type {string[]} */ const reasons = [];
  /** @type {string[]} */ const failures = [];

  /** @param {() => void} step */
  const attempt = (step) => {
    try {
      step();
    } catch (error) {
      if (error instanceof GhFailure) failures.push(error.message);
      else throw error;
    }
  };

  const origin = readOrigin(ctx, options.repoDir);
  if (!origin.ok) {
    return { code: 2, report: { decision: 'refuse', pr: options.pr, head, reasons: [origin.error] } };
  }
  const { owner, repo } = origin.origin;
  const base = `repos/${owner}/${repo}`;

  // A pull request from a fork has no number in the workflow_run payload:
  // without --pr, the one open pull request whose head is --head is it.
  let pr = options.pr;
  if (pr === null) {
    let resolved;
    try {
      resolved = resolvePullRequest(ctx, base, head);
    } catch (error) {
      if (!(error instanceof GhFailure)) throw error;
      return { code: 2, report: { decision: 'refuse', pr: null, head, reasons: [error.message] } };
    }
    if (typeof resolved !== 'number') return { code: 1, report: { decision: 'refuse', pr: null, head, reasons: [resolved] } };
    pr = resolved;
  }
  const number = pr;

  const found = { issue: /** @type {number | null} */ (null) };
  attempt(() => {
    const pr = readObject(ctx, `${base}/pulls/${number}`);
    reasons.push(...checkPullRequest(pr, number, head));
    const ref = isObject(pr.head) ? pr.head.ref : undefined;
    if (typeof ref !== 'string') throw new GhFailure(`gh api pulls/${number} returned a pull request without head ref`);
    found.issue = packageFromBranch(ref);
    if (found.issue === null) reasons.push(`pull request head ref "${ref}" is not a package branch (claude/wp-<n>)`);
  });
  const issue = found.issue;
  if (issue !== null) {
    attempt(() => reasons.push(...checkState(readPackageState(ctx, options.repoDir), issue, head)));
  }
  attempt(() => reasons.push(...checkFiles(readPages(ctx, `${base}/pulls/${number}/files`))));
  attempt(() => {
    const ownJobs = readOwnJobs(ctx, base);
    const runs = readCheckRuns(ctx, `${base}/commits/${head}/check-runs`);
    reasons.push(...checkRuns(runs.filter((run) => !ownJobs.has(run.id)), options.require));
  });

  const all = [...failures, ...reasons];
  if (failures.length > 0) return { code: 2, report: { decision: 'refuse', pr, head, reasons: all } };
  if (reasons.length > 0) return { code: 1, report: { decision: 'refuse', pr, head, reasons: all } };
  if (issue === null) return { code: 2, report: { decision: 'refuse', pr, head, reasons: ['no package resolved for the pull request'] } }; // unreachable: refused above

  // Sessions cannot delete branches (NF-012): the workflow's token does it here.
  const merge = ctx.gh([
    'pr', 'merge', String(pr), '--repo', `${owner}/${repo}`,
    '--squash', '--match-head-commit', head, '--delete-branch',
  ]);
  if (!merge.ok) {
    const reason = `gh pr merge failed (exit ${String(merge.code)}): ${merge.stderr || merge.stdout || 'no output'}`;
    return { code: 2, report: { decision: 'refuse', pr, head, reasons: [reason] } };
  }

  // The merge station moves the package on with the merge commit; if that
  // fails the merge stands and reconcile repairs the state later.
  const moved = moveToCleanup(ctx, base, number, issue, options.repoDir);
  if (moved !== null) return { code: 2, report: { decision: 'merge', pr, head, reasons: [moved] } };
  return { code: 0, report: { decision: 'merge', pr, head, reasons: [] } };
}

/**
 * Reads the merge commit of the merged pull request and records the
 * transition to cleanup on the state branch.
 *
 * @param {MergeContext} ctx
 * @param {string} base `repos/{owner}/{repo}`
 * @param {number} number the pull request
 * @param {number} issue the package
 * @param {string} repoDir
 * @returns {string | null} why the package was not moved, or null when it was
 */
function moveToCleanup(ctx, base, number, issue, repoDir) {
  let mergeCommit;
  try {
    mergeCommit = readObject(ctx, `${base}/pulls/${number}`).merge_commit_sha;
  } catch (error) {
    if (!(error instanceof GhFailure)) throw error;
    return `merged, but #${issue} was not moved to cleanup: cannot read the merge commit (${error.message})`;
  }
  if (typeof mergeCommit !== 'string' || !SHA.test(mergeCommit)) {
    return `merged, but #${issue} was not moved to cleanup: the pull request reports no merge commit`;
  }
  let moved;
  try {
    moved = ctx.state.transition(repoDir, { issue, to: 'cleanup', head: mergeCommit }, { now: ctx.now ?? new Date() });
  } catch (error) {
    return `merged, but #${issue} was not moved to cleanup: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!moved.ok) return `merged, but #${issue} was not moved to cleanup: ${moved.reason}`;
  return null;
}

/**
 * @param {Report} report
 * @returns {string} text output: one line per reason, or the merge
 */
export function formatReport(report) {
  const reasons = report.reasons.map((reason) => `${reason}\n`).join('');
  if (report.decision === 'merge') {
    return `merged pull request #${report.pr} at ${report.head}\n${reasons}`;
  }
  return reasons;
}

// --- reading the state branch ---------------------------------------------------

/**
 * The state branch as `readState` fetches it from the checkout's origin; a
 * git failure fails closed like a gh failure.
 *
 * @param {MergeContext} ctx
 * @param {string} repoDir
 * @returns {import('../lib/state.js').State}
 */
function readPackageState(ctx, repoDir) {
  try {
    return ctx.state.readState(repoDir).state;
  } catch (error) {
    throw new GhFailure(`cannot read the state branch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- reading through gh ------------------------------------------------------

/**
 * @param {MergeContext} ctx
 * @param {string} repoDir
 * @returns {{ ok: true, origin: Origin } | { ok: false, error: string }}
 */
function readOrigin(ctx, repoDir) {
  const result = ctx.git(['-C', repoDir, 'remote', 'get-url', 'origin']);
  if (!result.ok) {
    return { ok: false, error: `cannot read the origin of ${repoDir}: ${result.stderr || 'git failed'}` };
  }
  const origin = parseOrigin(result.stdout);
  if (!origin) return { ok: false, error: `origin is not a GitHub repository URL: ${result.stdout}` };
  return { ok: true, origin };
}

/**
 * @param {MergeContext} ctx
 * @param {string[]} args
 * @returns {unknown} parsed stdout
 */
function api(ctx, args) {
  const result = ctx.gh(['api', ...args]);
  const call = `gh api ${args[args.length - 1]}`;
  if (!result.ok) {
    throw new GhFailure(`${call} failed (exit ${String(result.code)}): ${result.stderr || result.stdout || 'no output'}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GhFailure(`${call} returned something other than JSON`);
  }
}

/**
 * @param {MergeContext} ctx
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function readObject(ctx, path) {
  const value = api(ctx, [path]);
  if (!isObject(value)) throw new GhFailure(`gh api ${path} returned something other than an object`);
  return value;
}

/**
 * All pages of a list endpoint (`--paginate --slurp` yields one array of pages).
 *
 * @param {MergeContext} ctx
 * @param {string} path
 * @returns {unknown[]} pages
 */
function readPages(ctx, path) {
  const pages = api(ctx, ['--paginate', '--slurp', `${path}${path.includes('?') ? PAGE.replace('?', '&') : PAGE}`]);
  if (!Array.isArray(pages)) throw new GhFailure(`gh api ${path} returned something other than an array of pages`);
  return pages;
}

/**
 * @typedef {{ id: number, name: string, status: string, conclusion: string | null }} CheckRun
 */

/**
 * @param {MergeContext} ctx
 * @param {string} path
 * @returns {CheckRun[]}
 */
function readCheckRuns(ctx, path) {
  /** @type {CheckRun[]} */ const runs = [];
  for (const page of readPages(ctx, path)) {
    if (!isObject(page) || !Array.isArray(page.check_runs)) {
      throw new GhFailure(`gh api ${path} returned a page without check_runs`);
    }
    for (const run of page.check_runs) {
      if (
        !isObject(run) ||
        typeof run.id !== 'number' ||
        typeof run.name !== 'string' ||
        typeof run.status !== 'string' ||
        !(run.conclusion === null || typeof run.conclusion === 'string')
      ) {
        throw new GhFailure(`gh api ${path} returned a check run without id, name, status or conclusion`);
      }
      runs.push({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion });
    }
  }
  return runs;
}

/**
 * Inside GitHub Actions the trusted workflow's own jobs are check runs on the
 * same head sha and still in progress while it decides. Only the jobs of the
 * run identified by GITHUB_RUN_ID are exempt from the "no other check run
 * failed or is running" rule; they never satisfy a required check.
 *
 * @param {MergeContext} ctx
 * @param {string} base `repos/{owner}/{repo}`
 * @returns {Set<number>} check-run ids of this workflow run's jobs
 */
function readOwnJobs(ctx, base) {
  /** @type {Set<number>} */ const ids = new Set();
  const runId = ctx.env.GITHUB_RUN_ID;
  if (runId === undefined || runId === '') return ids;
  if (!NUMBER.test(runId)) throw new GhFailure(`GITHUB_RUN_ID is not a run id: "${runId}"`);
  const path = `${base}/actions/runs/${runId}/jobs`;
  for (const page of readPages(ctx, path)) {
    if (!isObject(page) || !Array.isArray(page.jobs)) {
      throw new GhFailure(`gh api ${path} returned a page without jobs`);
    }
    for (const job of page.jobs) {
      if (!isObject(job) || typeof job.id !== 'number') throw new GhFailure(`gh api ${path} returned a job without id`);
      ids.add(job.id);
    }
  }
  return ids;
}

/**
 * The number of the one open pull request whose head is `head`, or the
 * reason there is none or several.
 *
 * @param {MergeContext} ctx
 * @param {string} base `repos/{owner}/{repo}`
 * @param {string} head
 * @returns {number | string}
 */
function resolvePullRequest(ctx, base, head) {
  const path = `${base}/pulls?state=open`;
  /** @type {number[]} */ const matches = [];
  for (const page of readPages(ctx, path)) {
    if (!Array.isArray(page)) throw new GhFailure(`gh api ${path} returned a page that is not an array`);
    for (const pr of page) {
      if (!isObject(pr) || typeof pr.number !== 'number' || !isObject(pr.head) || typeof pr.head.sha !== 'string') {
        throw new GhFailure(`gh api ${path} returned a pull request without number or head sha`);
      }
      if (pr.head.sha === head) matches.push(pr.number);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return `no open pull request has head ${head}`;
  return `${matches.length} open pull requests have head ${head}: ${matches.map((n) => `#${n}`).join(', ')}`;
}

// --- rules ---------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} pr the pull request as GitHub reports it
 * @param {number} number the pull request asked for
 * @param {string} head the sha the gates ran on
 * @returns {string[]} reasons
 */
function checkPullRequest(pr, number, head) {
  const headSha = isObject(pr.head) ? pr.head.sha : undefined;
  const baseRef = isObject(pr.base) ? pr.base.ref : undefined;
  const defaultBranch = isObject(pr.base) && isObject(pr.base.repo) ? pr.base.repo.default_branch : undefined;
  if (
    typeof pr.number !== 'number' ||
    typeof pr.state !== 'string' ||
    typeof pr.draft !== 'boolean' ||
    typeof headSha !== 'string' ||
    typeof baseRef !== 'string' ||
    typeof defaultBranch !== 'string'
  ) {
    throw new GhFailure(`gh api pulls/${number} returned a pull request without number, state, draft, head sha, base ref or default branch`);
  }

  /** @type {string[]} */ const reasons = [];
  if (pr.number !== number) reasons.push(`pull request #${pr.number} was returned for #${number}`);
  if (headSha !== head) reasons.push(`pull request head is ${headSha}, not ${head}`);
  if (pr.draft) reasons.push('pull request is a draft');
  if (pr.state !== 'open') reasons.push(`pull request is not open (state: ${pr.state})`);
  if (baseRef !== defaultBranch) {
    reasons.push(`pull request base is "${baseRef}", not the default branch "${defaultBranch}"`);
  }
  if (pr.mergeable !== true) {
    const state = typeof pr.mergeable_state === 'string' ? pr.mergeable_state : 'unknown';
    reasons.push(`pull request is not mergeable (mergeable: ${String(pr.mergeable)}, mergeable_state: ${state})`);
  }
  return reasons;
}

/**
 * NF-012: the state branch must say the package is at merge with the pull
 * request's head.
 *
 * @param {import('../lib/state.js').State} state
 * @param {number} issue
 * @param {string} head the pull request head
 * @returns {string[]} reasons
 */
function checkState(state, issue, head) {
  const pkg = state.packages[String(issue)];
  if (!pkg) return [`#${issue} is unknown to the state branch`];
  /** @type {string[]} */ const reasons = [];
  if (pkg.station !== 'merge') reasons.push(`#${issue} is at ${pkg.station}, not merge`);
  if (pkg.head !== head) reasons.push(`state head ${pkg.head ?? 'none'} is not the pull request head ${head}`);
  return reasons;
}

/**
 * @param {unknown[]} pages of `pulls/{n}/files`
 * @returns {string[]} reasons, one per protected path
 */
function checkFiles(pages) {
  /** @type {string[]} */ const reasons = [];
  for (const page of pages) {
    if (!Array.isArray(page)) throw new GhFailure('gh api pulls/{n}/files returned a page that is not an array');
    for (const file of page) {
      if (!isObject(file) || typeof file.filename !== 'string') {
        throw new GhFailure('gh api pulls/{n}/files returned a file without filename');
      }
      const paths = [file.filename];
      if (typeof file.previous_filename === 'string') paths.push(file.previous_filename);
      for (const path of paths) {
        if (isProtected(path)) reasons.push(`protected path changed: ${path}`);
      }
    }
  }
  return reasons;
}

/**
 * @param {string} path repository-relative, forward slashes
 * @returns {boolean}
 */
export function isProtected(path) {
  const [first] = path.split('/');
  return PROTECTED_DIRS.includes(first) || PROTECTED_FILES.includes(path);
}

/**
 * @param {CheckRun[]} runs check runs on the head sha, own jobs excluded
 * @param {string[]} required check names that must be present and successful
 * @returns {string[]} reasons
 */
function checkRuns(runs, required) {
  /** @type {string[]} */ const reasons = [];
  for (const name of required) {
    const named = runs.filter((run) => run.name === name);
    if (named.length === 0) {
      reasons.push(`required check "${name}" not found on the head commit`);
      continue;
    }
    for (const run of named) {
      if (run.status !== 'completed') {
        reasons.push(`required check "${name}" is still in progress (status: ${run.status})`);
      } else if (run.conclusion !== 'success') {
        reasons.push(`required check "${name}" did not succeed (conclusion: ${String(run.conclusion)})`);
      }
    }
  }
  for (const run of runs) {
    if (run.status !== 'completed' || run.conclusion === null) {
      reasons.push(`check "${run.name}" is still in progress (status: ${run.status})`);
    } else if (!HARMLESS.has(run.conclusion)) {
      reasons.push(`check "${run.name}" concluded ${run.conclusion}`);
    }
  }
  return reasons;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
