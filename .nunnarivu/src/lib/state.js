// @ts-check

/**
 * The work-package state model (architecture §2, KR-01, KR-08, KR-09, KR-10).
 * Pure functions, no I/O: `state-branch.js` reads and writes the files on the
 * orphan branch, this module decides what the files say.
 */

/** The stations of the production line, in order (KR-01). */
export const STATIONS = Object.freeze(
  /** @type {const} */ (['ready', 'isolate', 'test', 'build', 'prove', 'review', 'merge', 'cleanup']),
);

/** A package that cannot reach the bar (KR-07). Terminal in this core. */
export const BLOCKED = 'blocked';

/** Lease a working station holds when the request names none. */
export const DEFAULT_LEASE_MINUTES = 60;

/**
 * The session link `run` records when it starts a session, before the
 * dispatcher knows the link (decision NF-012). A package whose `run_url` is
 * null is waiting for a session; `pending` or a link means one was started.
 */
export const PENDING_RUN = 'pending';

/** Stations where nobody works on the package, so it holds no lease. */
const UNLEASED = new Set(['ready', BLOCKED, 'cleanup']);

/**
 * @typedef {typeof STATIONS[number]} Station
 * @typedef {Station | typeof BLOCKED} StationOrBlocked
 * @typedef {{
 *   issue: number,
 *   station: StationOrBlocked,
 *   head: string | null,
 *   attempt: number,
 *   lease_expires_at: string | null,
 *   run_url: string | null,
 *   blocked_reason: string | null,
 *   updated_at: string,
 * }} WorkPackage
 * @typedef {{
 *   write_sets: Record<string, string[]>,
 *   merge_lock: { issue: number, expires_at: string } | null,
 * }} Locks
 * @typedef {{ packages: Record<string, WorkPackage>, locks: Locks }} State
 * @typedef {{
 *   issue: number,
 *   to: StationOrBlocked,
 *   head?: string | null,
 *   run_url?: string | null,
 *   claim?: string[],
 *   lease_minutes?: number,
 *   reason?: string,
 * }} TransitionRequest
 * @typedef {{ ok: true, state: State } | { ok: false, reason: string }} TransitionResult
 * @typedef {{ issue: number, head?: string | null, run_url?: string | null, done?: boolean }} AnnotateRequest
 * @typedef {{ issue: number, station: Station, lease_minutes?: number }} StartRequest
 * @typedef {{ issue: number, from: StationOrBlocked, to: 'ready', attempt: number }} LeaseChange
 *
 * A package moved to `blocked` carries the reason it could not go on (KR-07);
 * at every other station `blocked_reason` is null. `run_url` is null while
 * the package waits for a session at its station (NF-012): every transition
 * into a station clears it unless the request carries one, `applyStart`
 * sets it, and a `done` annotation clears it again.
 */

/** @returns {State} */
export function emptyState() {
  return { packages: {}, locks: { write_sets: {}, merge_lock: null } };
}

/**
 * Applies one transition: validates the request, checks the guard (next
 * station only, `blocked` from anywhere, `ready` from anywhere once the
 * lease has expired), claims the write set and takes or releases the merge
 * lock — all in one result, so one commit records all of it (architecture
 * §2). Never mutates its input.
 *
 * @param {State} state
 * @param {TransitionRequest} request
 * @param {Date} now
 * @returns {TransitionResult}
 */
export function applyTransition(state, request, now) {
  const invalid = validateRequest(request);
  if (invalid) return { ok: false, reason: invalid };

  const key = String(request.issue);
  const current = state.packages[key];
  const next = structuredClone(state);

  if (!current) {
    if (request.to !== 'ready') {
      return { ok: false, reason: `#${request.issue} is unknown; a package enters at ready` };
    }
    next.packages[key] = {
      issue: request.issue,
      station: 'ready',
      head: request.head ?? null,
      attempt: 1,
      lease_expires_at: null,
      run_url: null,
      blocked_reason: null,
      updated_at: now.toISOString(),
    };
  } else if (request.to === 'ready') {
    if (current.station === 'ready') {
      return { ok: false, reason: `#${request.issue} is already at ready` };
    }
    if (!leaseExpired(current, now)) {
      return {
        ok: false,
        reason: current.lease_expires_at
          ? `#${request.issue} at ${current.station} holds a lease until ${current.lease_expires_at}`
          : `#${request.issue} at ${current.station} holds no lease and cannot return to ready`,
      };
    }
    returnToReady(next, key, now);
  } else if (request.to === BLOCKED) {
    if (current.station === BLOCKED) {
      return { ok: false, reason: `#${request.issue} is already blocked` };
    }
  } else if (current.station === BLOCKED) {
    return { ok: false, reason: `#${request.issue} is blocked` };
  } else if (nextStation(current.station) !== request.to) {
    return {
      ok: false,
      reason: `#${request.issue} is at ${current.station}; the next station is ${nextStation(current.station) ?? 'none'}, not ${request.to}`,
    };
  }

  const pkg = next.packages[key];
  const wasAtMerge = current?.station === 'merge';

  if (request.claim) {
    const clash = findOverlap(next.locks.write_sets, key, request.claim);
    if (clash) {
      return { ok: false, reason: `write set ${clash.glob} overlaps ${clash.other} claimed by #${clash.issue}` };
    }
    if (request.claim.length > 0) next.locks.write_sets[key] = [...request.claim];
    else delete next.locks.write_sets[key];
  }

  if (request.to !== 'ready') {
    pkg.station = request.to;
    pkg.updated_at = now.toISOString();
    if (request.to === BLOCKED) pkg.blocked_reason = /** @type {string} */ (request.reason).trim();
    pkg.lease_expires_at = UNLEASED.has(request.to)
      ? null
      : new Date(now.getTime() + (request.lease_minutes ?? DEFAULT_LEASE_MINUTES) * 60_000).toISOString();
    pkg.run_url = request.run_url ?? null; // a new station has no session yet (NF-012)
  }
  if (request.head !== undefined) pkg.head = request.head;

  if (request.to === 'merge') {
    const lock = next.locks.merge_lock;
    if (lock && lock.issue !== request.issue && Date.parse(lock.expires_at) > now.getTime()) {
      return { ok: false, reason: `merge lock is held by #${lock.issue} until ${lock.expires_at}` };
    }
    next.locks.merge_lock = { issue: request.issue, expires_at: /** @type {string} */ (pkg.lease_expires_at) };
  } else if (wasAtMerge) {
    releaseMergeLock(next, request.issue);
  }
  if (request.to === 'cleanup') delete next.locks.write_sets[key];

  return { ok: true, state: next };
}

/**
 * Marks a package waiting at `station` as started (decision NF-012): the
 * package must be at that station with no session recorded. Sets `run_url`
 * to `PENDING_RUN`, renews the lease and moves `updated_at`; nothing else
 * changes. Refuses an unknown package, a package elsewhere, a package that
 * already has a session and a station that holds no lease (ready, blocked,
 * cleanup). Never mutates its input.
 *
 * @param {State} state
 * @param {StartRequest} request
 * @param {Date} now
 * @returns {TransitionResult}
 */
export function applyStart(state, request, now) {
  if (!Number.isInteger(request.issue) || request.issue <= 0) {
    return { ok: false, reason: `issue must be a positive integer, got ${request.issue}` };
  }
  const station = /** @type {string} */ (request.station);
  if (!STATIONS.includes(/** @type {Station} */ (station)) && station !== BLOCKED) {
    return { ok: false, reason: `unknown station ${station}; stations are ${STATIONS.join(', ')}` };
  }
  const lease = request.lease_minutes;
  if (lease !== undefined && !(typeof lease === 'number' && Number.isFinite(lease) && lease >= 0)) {
    return { ok: false, reason: `lease_minutes must be a non-negative number, got ${lease}` };
  }
  const key = String(request.issue);
  const current = state.packages[key];
  if (!current) return { ok: false, reason: `#${request.issue} is unknown` };
  if (current.station !== station) return { ok: false, reason: `#${request.issue} is at ${current.station}, not ${station}` };
  if (UNLEASED.has(station)) return { ok: false, reason: `${station} holds no lease; no session is started there` };
  if (current.run_url !== null) {
    return { ok: false, reason: `#${request.issue} at ${station} already has a session: ${current.run_url}` };
  }
  const next = structuredClone(state);
  const pkg = next.packages[key];
  pkg.run_url = PENDING_RUN;
  pkg.lease_expires_at = new Date(now.getTime() + (lease ?? DEFAULT_LEASE_MINUTES) * 60_000).toISOString();
  pkg.updated_at = now.toISOString();
  return { ok: true, state: next };
}

/**
 * Records the run link and/or the head commit of a known package without
 * moving it: the station, attempt, lease and locks stay as they are and only
 * `updated_at` moves. The dispatcher records the session link this way; a
 * session that ends without moving the package records `done`, which clears
 * the link so the package waits for its next session (NF-012). Never
 * mutates its input.
 *
 * @param {State} state
 * @param {AnnotateRequest} request
 * @param {Date} now
 * @returns {TransitionResult}
 */
export function applyAnnotation(state, request, now) {
  if (!Number.isInteger(request.issue) || request.issue <= 0) {
    return { ok: false, reason: `issue must be a positive integer, got ${request.issue}` };
  }
  if (request.done !== undefined && typeof request.done !== 'boolean') return { ok: false, reason: 'done must be a boolean' };
  const done = request.done === true;
  if (request.head === undefined && request.run_url === undefined && !done) {
    return { ok: false, reason: `nothing to record for #${request.issue}: give a head, a run link or done` };
  }
  if (done && request.run_url !== undefined) {
    return { ok: false, reason: `done clears the session link of #${request.issue}; a run link cannot be given with it` };
  }
  if (request.head != null && !/^[0-9a-f]{40}$/.test(request.head)) {
    return { ok: false, reason: `head must be a full lowercase commit hash, got ${request.head}` };
  }
  if (request.run_url != null && typeof request.run_url !== 'string') return { ok: false, reason: 'run_url must be a string' };
  const key = String(request.issue);
  if (!state.packages[key]) return { ok: false, reason: `#${request.issue} is unknown` };
  const next = structuredClone(state);
  const pkg = next.packages[key];
  if (request.head !== undefined) pkg.head = request.head;
  if (request.run_url !== undefined) pkg.run_url = request.run_url;
  if (done) pkg.run_url = null;
  pkg.updated_at = now.toISOString();
  return { ok: true, state: next };
}

/**
 * Returns every started package past its lease to ready with attempt + 1,
 * releasing its write set and merge lock (used by reconcile, KR-10). A
 * package waiting for a session (`run_url` null) never expires (NF-012).
 * Never mutates its input.
 *
 * @param {State} state
 * @param {Date} now
 * @returns {{ state: State, changes: LeaseChange[] }}
 */
export function expireLeases(state, now) {
  const next = structuredClone(state);
  /** @type {LeaseChange[]} */
  const changes = [];
  for (const key of Object.keys(next.packages).sort((a, b) => Number(a) - Number(b))) {
    const pkg = next.packages[key];
    if (pkg.station === 'ready' || pkg.run_url === null || !leaseExpired(pkg, now)) continue;
    const from = pkg.station;
    returnToReady(next, key, now);
    changes.push({ issue: pkg.issue, from, to: 'ready', attempt: pkg.attempt });
  }
  return { state: next, changes };
}

/**
 * Two write-set globs overlap when they are identical or one names a
 * directory the other lies under. A glob is reduced to the directory it
 * covers by dropping a trailing `/`, `/*` or `/**`; a bare `*` or `**`
 * covers everything. Anything finer (`src/*.js` against `src/util/x.js`) is
 * deliberately treated as disjoint: write sets are declared per package and
 * are expected to be directories or whole files.
 *
 * @param {string} a
 * @param {string} b
 */
export function globsOverlap(a, b) {
  const x = directoryOf(a);
  const y = directoryOf(b);
  if (x === '' || y === '') return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * The state as the files on the branch: `wp/<issue>.json` per package and
 * `locks.json`, each pretty-printed with a trailing newline.
 *
 * @param {State} state
 * @returns {Record<string, string>}
 */
export function toFiles(state) {
  /** @type {Record<string, string>} */
  const files = { 'locks.json': `${JSON.stringify(state.locks, null, 2)}\n` };
  for (const pkg of Object.values(state.packages)) {
    files[`wp/${pkg.issue}.json`] = `${JSON.stringify(pkg, null, 2)}\n`;
  }
  return files;
}

/**
 * Parses the branch's files back into a state; files that are not part of
 * the model (the ledger, for one) are ignored. Throws naming the file when
 * one is corrupt.
 *
 * @param {Record<string, string>} files
 * @returns {State}
 */
export function fromFiles(files) {
  const state = emptyState();
  for (const [path, text] of Object.entries(files)) {
    const match = /^wp\/(\d+)\.json$/.exec(path);
    if (match) {
      const pkg = parsePackage(path, text);
      if (String(pkg.issue) !== match[1]) throw new Error(`${path}: issue ${pkg.issue} does not match the file name`);
      state.packages[match[1]] = pkg;
    } else if (path === 'locks.json') {
      state.locks = parseLocks(path, text);
    }
  }
  return state;
}

/**
 * @param {Station} station
 * @returns {Station | null}
 */
function nextStation(station) {
  const index = STATIONS.indexOf(station);
  return index >= 0 && index + 1 < STATIONS.length ? STATIONS[index + 1] : null;
}

/** @param {WorkPackage} pkg @param {Date} now */
function leaseExpired(pkg, now) {
  return pkg.lease_expires_at !== null && Date.parse(pkg.lease_expires_at) <= now.getTime();
}

/** @param {State} state @param {string} key @param {Date} now */
function returnToReady(state, key, now) {
  const pkg = state.packages[key];
  pkg.station = 'ready';
  pkg.attempt += 1;
  pkg.lease_expires_at = null;
  pkg.run_url = null;
  pkg.updated_at = now.toISOString();
  delete state.locks.write_sets[key];
  releaseMergeLock(state, pkg.issue);
}

/** @param {State} state @param {number} issue */
function releaseMergeLock(state, issue) {
  if (state.locks.merge_lock?.issue === issue) state.locks.merge_lock = null;
}

/**
 * @param {Record<string, string[]>} writeSets
 * @param {string} key the claiming package
 * @param {string[]} claim
 * @returns {{ glob: string, other: string, issue: string } | null}
 */
function findOverlap(writeSets, key, claim) {
  for (const [issue, globs] of Object.entries(writeSets)) {
    if (issue === key) continue;
    for (const glob of claim) {
      const other = globs.find((g) => globsOverlap(glob, g));
      if (other !== undefined) return { glob, other, issue };
    }
  }
  return null;
}

/** @param {string} glob */
function directoryOf(glob) {
  let path = glob.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  while (/\/\*{1,2}$/.test(path)) path = path.replace(/\/\*{1,2}$/, '');
  return /^\*{1,2}$/.test(path) ? '' : path;
}

/**
 * @param {TransitionRequest} request
 * @returns {string | null} a reason when the request is malformed
 */
function validateRequest(request) {
  if (!Number.isInteger(request.issue) || request.issue <= 0) return `issue must be a positive integer, got ${request.issue}`;
  if (!STATIONS.includes(/** @type {Station} */ (request.to)) && request.to !== BLOCKED) {
    return `unknown station ${request.to}; stations are ${STATIONS.join(', ')} or ${BLOCKED}`;
  }
  if (request.head != null && !/^[0-9a-f]{40}$/.test(request.head)) return `head must be a full lowercase commit hash, got ${request.head}`;
  if (request.run_url != null && typeof request.run_url !== 'string') return 'run_url must be a string';
  if (request.to === 'ready' && request.run_url != null) return 'a package at ready has no session; run_url is not given with --to ready';
  if (request.claim !== undefined) {
    if (!Array.isArray(request.claim)) return 'claim must be a list of globs';
    for (const glob of request.claim) {
      if (typeof glob !== 'string' || glob === '') return 'a write-set glob must be a non-empty string';
      if (glob.startsWith('/') || glob.split('/').includes('..')) return `a write-set glob must be relative to the repository, got ${glob}`;
    }
  }
  if (request.reason !== undefined && typeof request.reason !== 'string') return 'reason must be a string';
  if (request.to === BLOCKED && !(typeof request.reason === 'string' && request.reason.trim() !== '')) {
    return `moving #${request.issue} to blocked needs a reason (KR-07)`;
  }
  if (request.to !== BLOCKED && request.reason !== undefined) return 'a reason is given only when moving to blocked';
  if (request.lease_minutes !== undefined && !(typeof request.lease_minutes === 'number' && Number.isFinite(request.lease_minutes) && request.lease_minutes >= 0)) {
    return `lease_minutes must be a non-negative number, got ${request.lease_minutes}`;
  }
  return null;
}

/** @param {string} path @param {string} text @returns {WorkPackage} */
function parsePackage(path, text) {
  const raw = parseJson(path, text);
  const ok =
    Number.isInteger(raw.issue) &&
    (STATIONS.includes(raw.station) || raw.station === BLOCKED) &&
    (raw.head === null || typeof raw.head === 'string') &&
    Number.isInteger(raw.attempt) &&
    (raw.lease_expires_at === null || typeof raw.lease_expires_at === 'string') &&
    (raw.run_url === null || typeof raw.run_url === 'string') &&
    (raw.blocked_reason === undefined || raw.blocked_reason === null || typeof raw.blocked_reason === 'string') &&
    typeof raw.updated_at === 'string';
  if (!ok) throw new Error(`${path}: not a work-package record`);
  return {
    issue: raw.issue,
    station: raw.station,
    head: raw.head,
    attempt: raw.attempt,
    lease_expires_at: raw.lease_expires_at,
    run_url: raw.run_url,
    blocked_reason: raw.blocked_reason ?? null,
    updated_at: raw.updated_at,
  };
}

/** @param {string} path @param {string} text @returns {Locks} */
function parseLocks(path, text) {
  const raw = parseJson(path, text);
  const writeSets = raw.write_sets;
  const lock = raw.merge_lock;
  const ok =
    writeSets !== null &&
    typeof writeSets === 'object' &&
    !Array.isArray(writeSets) &&
    Object.values(writeSets).every((globs) => Array.isArray(globs) && globs.every((g) => typeof g === 'string')) &&
    (lock === null || (lock && Number.isInteger(lock.issue) && typeof lock.expires_at === 'string'));
  if (!ok) throw new Error(`${path}: not a locks record`);
  return { write_sets: writeSets, merge_lock: lock === null ? null : { issue: lock.issue, expires_at: lock.expires_at } };
}

/** @param {string} path @param {string} text @returns {any} */
function parseJson(path, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected a JSON object`);
  return value;
}
