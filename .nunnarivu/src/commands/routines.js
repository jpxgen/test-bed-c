// @ts-check
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultBranch, httpsOrigin } from './run.js';

/**
 * `nunnarivu routines`: the routine definitions of architecture §1 and §3
 * (dispatch on a schedule, pull-request on the project's pull-request
 * events) from `templates/routines/`, with the repository's origin and
 * default branch filled into the prompts, for the owner to create in the
 * Claude Code routines UI or with `create_trigger`. The kit copy carries
 * the same templates at `.nunnarivu/templates/routines/`.
 */

/**
 * @typedef {import('../cli.js').Io} Io
 * @typedef {{ cwd: string, git: (cwd: string, args: string[]) => string, templatesDir: string }} RoutinesContext
 * @typedef {{ kind: 'schedule', cron: string } | { kind: 'pull_request', events: string[] }} Trigger
 * @typedef {{ name: string, prompt: string, trigger: Trigger, fresh_session: true, notes: string, template: string }} Routine
 * @typedef {{ fact: string, detail: string }} OwnerFact
 * @typedef {{ schema: 1, placeholders: Record<string, string>, owner_sets: OwnerFact[], routines: Routine[] }} RoutinesIndex
 * @typedef {{ repository: string, default_branch: string }} Facts
 */

/** The placeholders a prompt template may use; `fillPrompt` replaces each. */
export const PLACEHOLDERS = Object.freeze(['{{repository}}', '{{default_branch}}']);

const INDEX_FILE = 'routines.json';

export const ROUTINES_USAGE = `Usage: nunnarivu routines [options]

Prints the routine definitions (dispatch, pull-request) with this repository's
origin and default branch filled into their prompts, so the owner can create
them in the Claude Code routines UI or with the create_trigger tool.

Options:
  --repo <dir>                   The repository (default: the current directory)
  --json                         Print the filled definitions as JSON
`;

class UsageError extends Error {}

/**
 * Exit 0 with the definitions printed, 1 when the templates or the
 * repository's origin cannot be read, 2 on a malformed command line.
 *
 * @param {string[]} args arguments after `routines`
 * @param {RoutinesContext} ctx
 * @param {Io} io
 * @returns {number}
 */
export function runRoutines(args, ctx, io) {
  try {
    const options = parse(args);
    const repo = options.repo === undefined ? ctx.cwd : resolve(ctx.cwd, options.repo);
    const index = loadRoutines(ctx.templatesDir);
    const facts = repositoryFacts(repo, ctx);
    const routines = index.routines.map((r) => ({
      name: r.name,
      trigger: r.trigger,
      fresh_session: r.fresh_session,
      notes: r.notes,
      prompt_file: r.prompt,
      prompt: fillPrompt(r.template, facts),
    }));
    const ownerSets = index.owner_sets.map((f) => ({ fact: f.fact, detail: fillPrompt(f.detail, facts) }));
    const out = { repository: facts.repository, default_branch: facts.default_branch, owner_sets: ownerSets, routines };
    io.stdout.write(options.json ? `${JSON.stringify(out, null, 2)}\n` : formatRoutines(out));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${ROUTINES_USAGE}`);
      return 2;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Reads `routines.json` and each routine's prompt template from the
 * templates directory. Throws naming the file when one is malformed.
 *
 * @param {string} templatesDir
 * @returns {RoutinesIndex}
 */
export function loadRoutines(templatesDir) {
  const file = join(templatesDir, INDEX_FILE);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const ok =
    raw !== null &&
    typeof raw === 'object' &&
    raw.schema === 1 &&
    raw.placeholders !== null &&
    typeof raw.placeholders === 'object' &&
    Array.isArray(raw.owner_sets) &&
    raw.owner_sets.every((/** @type {any} */ f) => f && typeof f.fact === 'string' && typeof f.detail === 'string') &&
    Array.isArray(raw.routines) &&
    raw.routines.every(
      (/** @type {any} */ r) =>
        r &&
        typeof r.name === 'string' &&
        typeof r.prompt === 'string' &&
        r.trigger &&
        (r.trigger.kind === 'schedule' ? typeof r.trigger.cron === 'string' : r.trigger.kind === 'pull_request' && Array.isArray(r.trigger.events)) &&
        r.fresh_session === true &&
        typeof r.notes === 'string',
    );
  if (!ok) throw new Error(`${file}: not a routines index`);
  /** @type {Routine[]} */
  const routines = raw.routines.map((/** @type {any} */ r) => ({
    name: r.name,
    prompt: r.prompt,
    trigger: r.trigger,
    fresh_session: true,
    notes: r.notes,
    template: readFileSync(join(templatesDir, r.prompt), 'utf8'),
  }));
  return { schema: 1, placeholders: raw.placeholders, owner_sets: raw.owner_sets, routines };
}

/**
 * Replaces every placeholder in a prompt template; a placeholder the facts
 * do not cover is an error, so no prompt ever goes out half filled.
 *
 * @param {string} template
 * @param {Facts} facts
 */
export function fillPrompt(template, facts) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (whole, name) => {
    if (!Object.hasOwn(facts, name)) throw new Error(`unknown placeholder ${whole}`);
    return facts[/** @type {keyof Facts} */ (name)];
  });
}

/**
 * @param {{ repository: string, default_branch: string, owner_sets: OwnerFact[], routines: { name: string, trigger: Trigger, fresh_session: boolean, notes: string, prompt: string }[] }} out
 */
function formatRoutines(out) {
  const lines = [`repository: ${out.repository}`, `default branch: ${out.default_branch}`, '', 'Before creating a routine, the owner sets:'];
  for (const fact of out.owner_sets) lines.push(`- ${fact.fact}: ${fact.detail}`);
  for (const r of out.routines) {
    lines.push('', `== ${r.name} ==`);
    lines.push(`trigger: ${r.trigger.kind === 'schedule' ? `schedule, cron ${r.trigger.cron} (UTC)` : `pull_request, events ${r.trigger.events.join(', ')}`}`);
    lines.push(`fresh session: ${r.fresh_session ? 'yes' : 'no'}`);
    lines.push(`notes: ${r.notes}`, 'prompt:', r.prompt.replace(/\n$/, ''));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} repo
 * @param {RoutinesContext} ctx
 * @returns {Facts}
 */
function repositoryFacts(repo, ctx) {
  const repository = httpsOrigin(ctx.git(repo, ['remote', 'get-url', 'origin']).trim());
  const base = defaultBranch(repo, ctx.git);
  if (base === null) throw new Error('cannot find the default branch: neither refs/remotes/origin/HEAD nor refs/remotes/origin/main exists');
  return { repository, default_branch: base.name };
}

/**
 * @param {string[]} args
 * @returns {{ repo: string | undefined, json: boolean }}
 */
function parse(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { repo: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length > 0) throw new UsageError(`routines takes no arguments, got ${parsed.positionals.join(' ')}`);
  return { repo: parsed.values.repo, json: parsed.values.json === true };
}
