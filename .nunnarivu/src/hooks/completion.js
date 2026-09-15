// @ts-check
/**
 * Stop hook (decision NF-012; architecture §2, §4): on a package branch
 * `claude/wp-<n>`, when the state branch is present locally and its
 * `wp/<n>.json` still records the station's session (`run_url` not null)
 * with a head that is not the branch's HEAD, remind that a station records
 * its completion — `state transition` to the next station, or `state
 * annotate --done` when the package stays — before the session ends. Context
 * only; it never blocks.
 *
 * The state is read from the local ref with `git show`, never fetched:
 * `readState` in state-branch.js fetches from origin, and a hook reads no
 * network. Inert when Claude Code is already continuing because of a stop
 * hook (`stop_hook_active`), so the reminder is given once per turn.
 *
 * Inert unless the repository is registered (registered.js).
 */
import { currentPackage } from '../lib/record.js';
import { contextOutput, cwdOf, runAsScript } from './io.js';
import { isRegistered } from './registered.js';

/** Where the state branch is found locally, in order of preference. */
export const STATE_REFS = Object.freeze(['refs/remotes/origin/nunnarivu/state', 'refs/heads/nunnarivu/state']);

/**
 * @typedef {import('./io.js').HookInput} HookInput
 * @typedef {import('./io.js').HookContext} HookContext
 * @typedef {import('./io.js').HookOutput} HookOutput
 */

/**
 * @param {HookInput} input
 * @param {HookContext} ctx
 * @returns {HookOutput | null}
 */
export function run(input, ctx) {
  try {
    if (input.stop_hook_active === true) return null;
    const cwd = cwdOf(input);
    if (!isRegistered(cwd, ctx.readFile)) return null;
    const issue = currentPackage(cwd, {}, ctx.git);
    if (issue === null) return null;
    const ref = STATE_REFS.find((r) => refExists(ctx, cwd, r));
    if (ref === undefined) return null;
    const pkg = JSON.parse(ctx.git(cwd, ['show', `${ref}:wp/${issue}.json`]));
    if (pkg === null || typeof pkg !== 'object') return null;
    if (pkg.run_url === null || pkg.run_url === undefined) return null;
    const head = ctx.git(cwd, ['rev-parse', 'HEAD']);
    if (pkg.head === head) return null;
    const recorded = typeof pkg.head === 'string' ? pkg.head.slice(0, 7) : 'none';
    const station = typeof pkg.station === 'string' ? pkg.station : 'its';
    return contextOutput(
      'Stop',
      `Package ${issue} is at the ${station} station with its session still recorded, and the branch head ${head.slice(0, 7)} is not the recorded head (${recorded}). ` +
        `A station records its completion on the state branch before the session ends (decision NF-012): ` +
        `\`node .nunnarivu/bin/nunnarivu state transition ${issue} --to <next station> --head $(git rev-parse HEAD)\` to move the package on, ` +
        `or \`node .nunnarivu/bin/nunnarivu state annotate ${issue} --done --head $(git rev-parse HEAD)\` when it stays at this station. ` +
        `A session that ends without one is treated as expired and returns to ready.`,
    );
  } catch {
    return null;
  }
}

/** @param {HookContext} ctx @param {string} cwd @param {string} ref */
function refExists(ctx, cwd, ref) {
  try {
    ctx.git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

runAsScript(import.meta.url, run);
