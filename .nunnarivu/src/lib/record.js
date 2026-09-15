// @ts-check
/**
 * The package record (decision NF-012): a work package's record —
 * `package.md`, `evidence.json`, `pull-request.json`, `review/round-<n>.json`
 * and `review/round-<n>.answers.json` — lives on its branch in
 * `nunnarivu/wp-<issue>/`. Gates, the evidence check and the trusted merge
 * find the record through the branch name `claude/wp-<issue>`
 * (`GITHUB_HEAD_REF` in CI). Pure except `currentPackage`, which asks the
 * injected git runner for the checked-out branch.
 */

/** @typedef {(cwd: string, args: string[]) => string} Git a git runner that returns stdout and throws on failure */

const BRANCH_PREFIX = 'claude/wp-';
const RECORD_PREFIX = 'nunnarivu/wp-';
const PACKAGE_BRANCH = /^claude\/wp-([1-9][0-9]*)$/;

/**
 * The directory of a package's record, relative to the repository root.
 *
 * @param {number} issue
 * @returns {string} `nunnarivu/wp-<issue>`
 */
export function recordDir(issue) {
  return `${RECORD_PREFIX}${checkedIssue(issue)}`;
}

/**
 * The branch a package is built on.
 *
 * @param {number} issue
 * @returns {string} `claude/wp-<issue>`
 */
export function packageBranch(issue) {
  return `${BRANCH_PREFIX}${checkedIssue(issue)}`;
}

/**
 * The issue number a package branch names, or null for any other ref.
 *
 * @param {string} name a short branch name
 * @returns {number | null}
 */
export function packageFromBranch(name) {
  const match = PACKAGE_BRANCH.exec(name);
  if (!match) return null;
  const issue = Number(match[1]);
  return Number.isSafeInteger(issue) ? issue : null;
}

/**
 * The package the current checkout belongs to: the pull request's head ref
 * when CI names one (`GITHUB_HEAD_REF`), else the checked-out branch. Null
 * when the named ref is not a package branch, or HEAD is detached.
 *
 * @param {string} repoDir
 * @param {Record<string, string | undefined>} env
 * @param {Git} git
 * @returns {number | null}
 */
export function currentPackage(repoDir, env, git) {
  const headRef = env.GITHUB_HEAD_REF;
  if (headRef !== undefined && headRef !== '') return packageFromBranch(headRef);
  let branch;
  try {
    branch = git(repoDir, ['symbolic-ref', '--short', 'HEAD']).trim();
  } catch {
    return null;
  }
  return packageFromBranch(branch);
}

/** @param {number} issue */
function checkedIssue(issue) {
  if (!Number.isInteger(issue) || issue <= 0) throw new RangeError(`issue must be a positive integer, got ${issue}`);
  return issue;
}
