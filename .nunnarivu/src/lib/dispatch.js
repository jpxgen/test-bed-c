// @ts-check
/**
 * The dispatch plan (architecture §1; decision NF-012; KR-08, KR-11): from
 * the work-package state, the capacity and the records, what the dispatcher
 * starts, what is running, what waits for the trusted-merge workflow, and
 * whether work is paused. Pure: the state is never mutated, the records are
 * read through the injected lookup, and nothing is started here — `run`
 * and the session tool start sessions.
 */
import { nextReviewSkill } from './review.js';
import { BLOCKED } from './state.js';

/**
 * Stations that hold a lease, so a package there is in flight whatever its
 * session link (NF-012). Merge is the trusted-merge workflow, still in
 * flight until it moves the package to cleanup.
 */
export const LEASED_STATIONS = Object.freeze(/** @type {const} */ (['isolate', 'test', 'build', 'prove', 'review', 'merge']));

/** Session stations whose skill is the station itself; review chooses between fix and review. */
const OWN_SKILL = new Set(['isolate', 'test', 'build', 'prove']);

/** The one rate-limit status under which sessions may start (KR-11). */
export const ALLOWED = 'allowed';

/**
 * @typedef {import('./state.js').State} State
 * @typedef {import('./state.js').WorkPackage} WorkPackage
 * @typedef {typeof LEASED_STATIONS[number]} LeasedStation
 * @typedef {{ issue: number, station: 'isolate' | 'test' | 'build' | 'prove' | 'review', skill: string }} Start
 * @typedef {{ issue: number, station: LeasedStation, run_url: string, lease_expires_at: string | null }} Running
 * @typedef {{ issue: number, station: 'merge' }} Waiting
 * @typedef {{
 *   state: State,
 *   capacity: number,
 *   records: (issue: number) => string[],
 *   rateLimit: string,
 * }} PlanInput
 * @typedef {{
 *   capacity: number,
 *   in_flight: number,
 *   starts: Start[],
 *   running: Running[],
 *   waiting: Waiting[],
 *   paused: string | null,
 *   done: number,
 *   blocked: number,
 * }} Plan
 */

/**
 * Plans one dispatch round over the packages in ascending issue order.
 *
 * - `in_flight`: packages at a leased station, whatever their session link.
 * - `starts`: a ready package enters isolate while `in_flight` plus the
 *   packages entered so far stay under the capacity (KR-08); a package
 *   waiting at isolate, test, build or prove starts that station's skill,
 *   and one waiting at review starts `fix` or `review` from its record
 *   (NF-012) — both are already in flight and consume no capacity.
 * - `running`: leased packages with a session started (`pending` or a link).
 * - `waiting`: packages at merge with no session: the review station
 *   dispatched the trusted-merge workflow, nothing is started for them.
 * - `paused`: null while the rate-limit status is `allowed`; otherwise the
 *   reason, and `starts` is empty while running and waiting are still
 *   reported (KR-11).
 * - Blocked and cleanup packages only add to the `blocked` and `done` counts.
 *
 * @param {PlanInput} input `records(issue)` gives the record's file names relative to `nunnarivu/wp-<issue>/`
 * @returns {Plan}
 * @throws {RangeError} when the capacity or the rate-limit status is malformed
 */
export function planDispatch({ state, capacity, records, rateLimit }) {
  if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  if (typeof rateLimit !== 'string' || rateLimit === '') throw new RangeError(`rate limit status must be a non-empty string, got ${rateLimit}`);
  const paused = rateLimit === ALLOWED ? null : `rate limit: ${rateLimit}`;
  const packages = Object.values(state.packages).sort((a, b) => a.issue - b.issue);

  const inFlight = packages.filter((pkg) => LEASED_STATIONS.includes(/** @type {LeasedStation} */ (pkg.station))).length;
  /** @type {Plan} */
  const plan = { capacity, in_flight: inFlight, starts: [], running: [], waiting: [], paused, done: 0, blocked: 0 };
  let entering = 0; // ready packages this plan sends into isolate

  for (const pkg of packages) {
    if (pkg.station === BLOCKED) {
      plan.blocked += 1;
    } else if (pkg.station === 'cleanup') {
      plan.done += 1;
    } else if (pkg.station === 'ready') {
      if (paused === null && inFlight + entering < capacity) {
        plan.starts.push({ issue: pkg.issue, station: 'isolate', skill: 'isolate' });
        entering += 1;
      }
    } else {
      if (pkg.run_url !== null) {
        plan.running.push({ issue: pkg.issue, station: pkg.station, run_url: pkg.run_url, lease_expires_at: pkg.lease_expires_at });
      } else if (pkg.station === 'merge') {
        plan.waiting.push({ issue: pkg.issue, station: 'merge' });
      } else if (paused === null) {
        plan.starts.push({ issue: pkg.issue, station: pkg.station, skill: skillFor(pkg, records) });
      }
    }
  }
  return plan;
}

/**
 * @param {WorkPackage} pkg a package waiting at isolate, test, build, prove or review
 * @param {(issue: number) => string[]} records
 */
function skillFor(pkg, records) {
  if (OWN_SKILL.has(pkg.station)) return pkg.station;
  return nextReviewSkill(records(pkg.issue));
}
