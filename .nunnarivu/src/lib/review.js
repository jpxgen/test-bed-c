// @ts-check
/**
 * The review core (architecture §5; KR-05, KR-06, KR-07): findings are
 * validated against `schemas/review.schema.json`, evidence-less blocking
 * and major findings are discarded, the score is computed from the gates,
 * the evidence and the open findings, and the round decides what happens
 * next. The fix skill's answers to a round are validated against
 * `schemas/answers.schema.json`, and the record's review files decide which
 * skill the review station runs next (decision NF-012). Pure functions; a
 * model is never asked for a score.
 */
import { readFileSync } from 'node:fs';
import { validate } from './schema.js';

/** @type {import('./schema.js').Schema} */
export const REVIEW_SCHEMA = Object.freeze(
  JSON.parse(readFileSync(new URL('../../schemas/review.schema.json', import.meta.url), 'utf8')),
);

/** @type {import('./schema.js').Schema} */
export const ANSWERS_SCHEMA = Object.freeze(
  JSON.parse(readFileSync(new URL('../../schemas/answers.schema.json', import.meta.url), 'utf8')),
);

/** The record's review files: `review/round-<n>.json` and `review/round-<n>.answers.json`. */
const ROUND_FILE = /^review\/round-([1-9][0-9]*)\.json$/;
const ANSWERS_FILE = /^review\/round-([1-9][0-9]*)\.answers\.json$/;

/** Severities, most serious first. */
export const SEVERITIES = Object.freeze(/** @type {const} */ (['blocking', 'major', 'minor', 'nit']));
/** Finding categories. */
export const CATEGORIES = Object.freeze(/** @type {const} */ (['correctness', 'security', 'tests', 'design', 'style', 'docs']));
/** Merge bar: the highest score. */
export const MAX_SCORE = 5;

/**
 * @typedef {typeof SEVERITIES[number]} Severity
 * @typedef {typeof CATEGORIES[number]} Category
 * @typedef {{
 *   file: string,
 *   line: number | null,
 *   severity: Severity,
 *   category: Category,
 *   rule: string,
 *   evidence: string,
 *   fix: string,
 * }} Finding
 * @typedef {{ schema: 1, reviewer: string, head: string, round: number, findings: Finding[] }} Review
 * @typedef {{ file: string, line: number | null, rule: string, outcome: 'fixed' | 'disputed', note: string }} Answer
 * @typedef {{ schema: 1, round: number, head: string, answers: Answer[] }} Answers
 * @typedef {{ finding: Finding, reason: string }} Discard
 * @typedef {1 | 2 | 3 | 4 | 5} Score
 * @typedef {'merge' | 'fix' | 'retry' | 'blocked'} Decision
 */

/**
 * @param {unknown} value a parsed `review.json`
 * @returns {{ ok: true, review: Review } | { ok: false, problems: string[] }} every problem, or the typed review
 */
export function validateReview(value) {
  const problems = validate(REVIEW_SCHEMA, value);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, review: /** @type {Review} */ (value) };
}

/**
 * @param {unknown} value a parsed `round-<n>.answers.json`
 * @returns {{ ok: true, answers: Answers } | { ok: false, problems: string[] }} every problem, or the typed answers
 */
export function validateAnswers(value) {
  const problems = validate(ANSWERS_SCHEMA, value);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, answers: /** @type {Answers} */ (value) };
}

/**
 * The skill the review station runs next (NF-012): `fix` when the highest
 * `review/round-<n>.json` in the record has no `review/round-<n>.answers.json`,
 * else `review` (also with no rounds at all).
 *
 * @param {string[]} files the record's file names, relative to `nunnarivu/wp-<issue>/`
 * @returns {'fix' | 'review'}
 */
export function nextReviewSkill(files) {
  let latest = 0;
  /** @type {Set<number>} */
  const answered = new Set();
  for (const file of files) {
    const round = ROUND_FILE.exec(file);
    if (round) latest = Math.max(latest, Number(round[1]));
    const answers = ANSWERS_FILE.exec(file);
    if (answers) answered.add(Number(answers[1]));
  }
  return latest > 0 && !answered.has(latest) ? 'fix' : 'review';
}

/**
 * KR-05: a `blocking` or `major` finding whose evidence is empty or
 * whitespace is discarded, except a `security` finding, which is never
 * discarded automatically. Order is preserved.
 *
 * @param {Finding[]} findings
 * @returns {{ kept: Finding[], discarded: Discard[] }}
 */
export function filterFindings(findings) {
  /** @type {Finding[]} */
  const kept = [];
  /** @type {Discard[]} */
  const discarded = [];
  for (const finding of findings) {
    const needsEvidence = finding.severity === 'blocking' || finding.severity === 'major';
    if (needsEvidence && finding.category !== 'security' && finding.evidence.trim() === '') {
      discarded.push({ finding, reason: `${finding.severity} finding without evidence` });
    } else {
      kept.push(finding);
    }
  }
  return { kept, discarded };
}

/**
 * The computed score of architecture §5. When several levels apply the
 * lowest wins: a failed gate is 1 whatever else is open; missing evidence
 * is 2 even with no findings.
 *
 * @param {{ gatesGreen: boolean, evidencePresent: boolean, findings: Finding[] }} input
 *   `findings` are the kept findings of the latest round
 * @returns {Score}
 */
export function scoreReview({ gatesGreen, evidencePresent, findings }) {
  const open = countBySeverity(findings);
  if (!gatesGreen) return 1;
  if (!evidencePresent || open.blocking > 0) return 2;
  if (open.major > 0) return 3;
  if (open.minor > 0 || open.nit > 0) return 4;
  return 5;
}

/**
 * @param {Finding[]} findings
 * @returns {Record<Severity, number>}
 */
export function countBySeverity(findings) {
  /** @type {Record<Severity, number>} */
  const counts = { blocking: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * What happens after a scored round (§5; KR-06, KR-07): `merge` when the
 * score meets the bar; otherwise `fix` while rounds remain, `retry` exactly
 * once when the last round misses the bar (the caller runs the fresh
 * attempt as round `maxRounds + 1`), `blocked` after that.
 *
 * @param {{ score: number, bar: number, round: number, maxRounds: number }} input
 * @returns {{ decision: Decision, reason: string }}
 * @throws {RangeError} when an input is outside its range
 */
export function decideRound({ score, bar, round, maxRounds }) {
  if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) throw new RangeError(`score must be an integer from 1 to ${MAX_SCORE}, got ${score}`);
  if (!Number.isInteger(bar) || bar < 1 || bar > MAX_SCORE) throw new RangeError(`bar must be an integer from 1 to ${MAX_SCORE}, got ${bar}`);
  if (!Number.isInteger(round) || round < 1) throw new RangeError(`round must be an integer of at least 1, got ${round}`);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new RangeError(`maxRounds must be an integer of at least 1, got ${maxRounds}`);
  if (score >= bar) return { decision: 'merge', reason: `score ${score} meets the bar ${bar} in round ${round}` };
  if (round < maxRounds) return { decision: 'fix', reason: `score ${score} is below the bar ${bar} in round ${round} of ${maxRounds}` };
  if (round === maxRounds) {
    return {
      decision: 'retry',
      reason: `score ${score} is below the bar ${bar} after ${round} of ${maxRounds} rounds: one fresh attempt at higher effort with a wider context pack, as round ${round + 1}`,
    };
  }
  return { decision: 'blocked', reason: `score ${score} is below the bar ${bar} after the retry (round ${round} of ${maxRounds})` };
}
