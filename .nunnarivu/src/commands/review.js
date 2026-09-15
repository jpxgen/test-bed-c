// @ts-check
/**
 * `nunnarivu review`: the deterministic half of the review loop
 * (architecture §5; KR-05, KR-06, KR-07). `validate` checks a reviewer's
 * `review.json` against the findings schema and applies the evidence rule,
 * or a fix skill's `round-<n>.answers.json` against the answers schema (told
 * apart by the `answers` key, NF-012); `score` computes the round's score from the gates, the evidence flag and
 * the kept findings, and decides merge, fix, retry or blocked. A model is
 * never asked for a score.
 */
import { parseArgs } from 'node:util';
import { validate } from '../lib/schema.js';
import { MAX_SCORE, countBySeverity, decideRound, filterFindings, scoreReview, validateAnswers, validateReview } from '../lib/review.js';

/**
 * @typedef {import('../cli.js').Io} Io
 * @typedef {import('../lib/review.js').Finding} Finding
 * @typedef {import('../lib/review.js').Review} Review
 * @typedef {{ readFile: (path: string) => string, version: string }} ReviewContext
 *   `readFile` throws an error whose `code` is `ENOENT` for a missing file
 * @typedef {{ name: string, status: 'pass' | 'fail' | 'skipped' }} GateResult
 */

export const REVIEW_USAGE = `Usage: nunnarivu review <command> [options]

Commands:
  validate <file>                Validate a review (review.json) against the findings schema
                                 and print the kept and discarded findings with reasons, or a
                                 fix skill's round-<n>.answers.json (told apart by its answers
                                 key) against the answers schema (exit 0 when valid, 1 when not)
  score --gates <gates.json> --evidence present|missing --review <review.json>
        --bar <n> --max-rounds <n> [--json]
                                 Score the round from the gates (as nunnarivu gate --json
                                 prints them), the evidence flag and the kept findings, then
                                 decide: exit 0 merge, 1 fix or retry, 2 blocked or malformed input
`;

/** The part of `nunnarivu gate --json` the score reads. @type {import('../lib/schema.js').Schema} */
const GATES_SCHEMA = {
  type: 'object',
  properties: {
    gates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, status: { enum: ['pass', 'fail', 'skipped'] } },
        required: ['name', 'status'],
        additionalProperties: true,
      },
    },
  },
  required: ['gates'],
  additionalProperties: true,
};

class UsageError extends Error {}
/** A file that cannot be read, parsed or validated. */
class InputError extends Error {}

/**
 * @param {string[]} args arguments after `review`
 * @param {ReviewContext} ctx
 * @param {Io} io
 * @returns {number} exit code
 */
export function runReview(args, ctx, io) {
  const [command, ...rest] = args;
  try {
    if (command === 'validate') return validateCommand(rest, ctx, io);
    if (command === 'score') return scoreCommand(rest, ctx, io);
    throw new UsageError(command === undefined ? 'review needs a command' : `Unknown review command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${REVIEW_USAGE}`);
      return 2;
    }
    throw error;
  }
}

/** @param {string[]} args @param {ReviewContext} ctx @param {Io} io */
function validateCommand(args, ctx, io) {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError('validate needs <review.json>');
  let value;
  try {
    value = readJson(positionals[0], ctx);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  const isAnswers = typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.hasOwn(value, 'findings') && Object.hasOwn(value, 'answers');
  const result = isAnswers ? validateAnswers(value) : validateReview(value);
  if (!result.ok) {
    io.stderr.write(`${describeProblems(positionals[0], result.problems)}\n`);
    return 1;
  }
  if ('answers' in result) {
    const { answers } = result;
    const fixed = answers.answers.filter((a) => a.outcome === 'fixed').length;
    io.stdout.write(`valid: round ${answers.round} answers, ${fixed} fixed, ${answers.answers.length - fixed} disputed\n`);
    for (const a of answers.answers) {
      io.stdout.write(`  [${a.outcome}] ${a.file}${a.line === null ? '' : `:${a.line}`}${a.rule === '' ? '' : ` (${a.rule})`}: ${a.note}\n`);
    }
    return 0;
  }
  const { kept, discarded } = filterFindings(result.review.findings);
  io.stdout.write(`valid: ${kept.length} kept, ${discarded.length} discarded\n`);
  if (kept.length > 0) io.stdout.write(`kept:\n${kept.map((f) => `  ${describe(f)}: ${f.fix}\n`).join('')}`);
  if (discarded.length > 0) io.stdout.write(`discarded:\n${discarded.map((d) => `  ${describe(d.finding)}: ${d.reason}\n`).join('')}`);
  return 0;
}

/** @param {string[]} args @param {ReviewContext} ctx @param {Io} io */
function scoreCommand(args, ctx, io) {
  const { positionals, values } = parse(args, {
    gates: { type: 'string' },
    evidence: { type: 'string' },
    review: { type: 'string' },
    bar: { type: 'string' },
    'max-rounds': { type: 'string' },
    json: { type: 'boolean' },
  });
  if (positionals.length > 0) throw new UsageError('score takes no arguments');
  if (!values.gates || !values.evidence || !values.review || !values.bar || !values['max-rounds']) {
    throw new UsageError('score needs --gates, --evidence, --review, --bar and --max-rounds');
  }
  if (values.evidence !== 'present' && values.evidence !== 'missing') {
    throw new UsageError(`--evidence must be present or missing, got ${values.evidence}`);
  }
  const bar = Number(values.bar);
  if (!/^\d+$/.test(values.bar) || bar < 1 || bar > MAX_SCORE) throw new UsageError(`--bar must be an integer from 1 to ${MAX_SCORE}, got ${values.bar}`);
  const maxRounds = Number(values['max-rounds']);
  if (!/^\d+$/.test(values['max-rounds']) || maxRounds < 1) throw new UsageError(`--max-rounds must be an integer of at least 1, got ${values['max-rounds']}`);

  let gates;
  let review;
  try {
    gates = readGates(values.gates, ctx);
    review = readReview(values.review, ctx);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return 2;
  }
  const failed = gates.filter((g) => g.status === 'fail').map((g) => g.name);
  const evidencePresent = values.evidence === 'present';
  const { kept, discarded } = filterFindings(review.findings);
  const { score, open, decision, reason } = scoreRound({ gatesGreen: failed.length === 0, evidencePresent, findings: kept, bar, round: review.round, maxRounds });

  if (values.json) {
    const record = {
      version: ctx.version,
      head: review.head,
      round: review.round,
      bar,
      max_rounds: maxRounds,
      gates_green: failed.length === 0,
      evidence_present: evidencePresent,
      score,
      open,
      findings: kept,
      discarded,
      decision,
      reason,
    };
    io.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    io.stdout.write(`score: ${score} (bar ${bar}, round ${review.round} of ${maxRounds})\n`);
    io.stdout.write(`gates: ${failed.length === 0 ? 'green' : `failed: ${failed.join(', ')}`}\n`);
    io.stdout.write(`evidence: ${values.evidence}\n`);
    io.stdout.write(`open: blocking ${open.blocking}, major ${open.major}, minor ${open.minor}, nit ${open.nit}\n`);
    for (const f of kept) io.stdout.write(`  ${describe(f)}: ${f.fix}\n`);
    io.stdout.write(`discarded: ${discarded.length}\n`);
    for (const d of discarded) io.stdout.write(`  ${describe(d.finding)}: ${d.reason}\n`);
    io.stdout.write(`decision: ${decision} (${reason})\n`);
  }
  return decision === 'merge' ? 0 : decision === 'blocked' ? 2 : 1;
}

/**
 * Score and decision of one round, from validated inputs.
 *
 * @param {{ gatesGreen: boolean, evidencePresent: boolean, findings: Finding[], bar: number, round: number, maxRounds: number }} input
 *   `findings` are the kept findings of the round
 */
export function scoreRound({ gatesGreen, evidencePresent, findings, bar, round, maxRounds }) {
  const score = scoreReview({ gatesGreen, evidencePresent, findings });
  const { decision, reason } = decideRound({ score, bar, round, maxRounds });
  return { score, open: countBySeverity(findings), decision, reason };
}

/** `[severity] file:line category` @param {Finding} f */
function describe(f) {
  return `[${f.severity}] ${f.file}${f.line === null ? '' : `:${f.line}`} ${f.category}`;
}

/**
 * @param {string} path
 * @param {ReviewContext} ctx
 * @returns {Review}
 * @throws {InputError}
 */
function readReview(path, ctx) {
  const result = validateReview(readJson(path, ctx));
  if (!result.ok) throw new InputError(describeProblems(path, result.problems));
  return result.review;
}

/**
 * @param {string} path
 * @param {ReviewContext} ctx
 * @returns {GateResult[]}
 * @throws {InputError}
 */
function readGates(path, ctx) {
  const value = readJson(path, ctx);
  const problems = validate(GATES_SCHEMA, value);
  if (problems.length > 0) throw new InputError(describeProblems(path, problems));
  return /** @type {{ gates: GateResult[] }} */ (value).gates;
}

/** @param {string} path @param {ReviewContext} ctx @returns {unknown} @throws {InputError} */
function readJson(path, ctx) {
  let text;
  try {
    text = ctx.readFile(path);
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    throw new InputError(`${path}: ${code === 'ENOENT' ? 'not found' : String(/** @type {Error} */ (error).message)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`${path}: not JSON (${/** @type {Error} */ (error).message})`);
  }
}

/** @param {string} file @param {string[]} problems */
function describeProblems(file, problems) {
  return problems.length === 1 ? `${file}: ${problems[0]}` : `${file}:\n${problems.map((p) => `  ${p}`).join('\n')}`;
}

/**
 * @template {import('node:util').ParseArgsConfig['options']} O
 * @param {string[]} args
 * @param {O} options
 */
function parse(args, options) {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { positionals: parsed.positionals, values: /** @type {Record<string, any>} */ (parsed.values) };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
