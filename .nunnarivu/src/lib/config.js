// @ts-check
/**
 * The project configuration `nunnarivu.yml` (architecture §9): read with the
 * kit's YAML subset, validated against `schemas/nunnarivu.schema.json`
 * (decision NF-011), optional sections defaulted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './schema.js';
import { YamlError, parse, stringify } from './yaml.js';

/** File name of the project configuration, at the repository root. */
export const CONFIG_FILE = 'nunnarivu.yml';

/**
 * The schema, read from inside the plugin (it is needed at run time).
 *
 * @type {import('./schema.js').Schema}
 */
export const SCHEMA = Object.freeze(
  JSON.parse(readFileSync(new URL('../../schemas/nunnarivu.schema.json', import.meta.url), 'utf8')),
);

/**
 * @typedef {{ check: string, test: string, test_scoped: string, e2e: string, fmt: string }} Commands
 * @typedef {'low' | 'medium' | 'xhigh'} Tier
 * @typedef {{ glob: string, tier: Tier, reviewers: string[] }} RiskPath
 * @typedef {{
 *   schema: 1,
 *   kit: string,
 *   commands: Commands,
 *   specialists: Record<string, { owns: string[] }>,
 *   risk_paths: RiskPath[],
 *   evidence: Record<string, { checker: string }>,
 *   review: { bar: number, max_rounds: number },
 *   models: Record<Tier, string>,
 *   capacity: { parallel: number, weekly_budget_usd: number },
 *   owner_only: string[],
 * }} Config
 */

export class ConfigError extends Error {
  /**
   * @param {string} file
   * @param {string[]} problems
   */
  constructor(file, problems) {
    super(problems.length === 1 ? `${file}: ${problems[0]}` : `${file}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.file = file;
    this.problems = problems;
  }
}

/**
 * Reads, parses and validates `<dir>/nunnarivu.yml`.
 *
 * @param {string} dir repository root
 * @returns {Config}
 * @throws {ConfigError} listing every problem
 */
export function loadConfig(dir) {
  const file = join(dir, CONFIG_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    throw new ConfigError(file, [code === 'ENOENT' ? 'not found' : String(/** @type {Error} */ (error).message)]);
  }
  return parseConfig(text, file);
}

/**
 * Parses and validates the text of a `nunnarivu.yml` already read, for callers
 * that read files through an injected reader.
 *
 * @param {string} text
 * @param {string} [file] path for error messages
 * @returns {Config}
 * @throws {ConfigError} listing every problem
 */
export function parseConfig(text, file = CONFIG_FILE) {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    if (error instanceof YamlError) throw new ConfigError(file, [error.message]);
    throw error;
  }
  return fromDocument(doc, file);
}

/**
 * Validates and writes `<dir>/nunnarivu.yml` in the subset `loadConfig` reads:
 * the kit's keys in their documented order, then any `x-` extension of the
 * project's (kept, never read).
 *
 * @param {string} dir repository root
 * @param {Config & Record<string, unknown>} config
 * @throws {ConfigError} listing every problem, writing nothing
 */
export function writeConfig(dir, config) {
  writeFileSync(join(dir, CONFIG_FILE), configText(config, join(dir, CONFIG_FILE)));
}

/**
 * The text `writeConfig` writes, for callers that compare before writing.
 *
 * @param {Config & Record<string, unknown>} config
 * @param {string} [file] path for error messages
 * @returns {string}
 * @throws {ConfigError} listing every problem
 */
export function configText(config, file = CONFIG_FILE) {
  const doc = /** @type {Record<string, unknown>} */ (config);
  /** @type {Record<string, unknown>} */
  const out = fromDocument(doc, file);
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('x-')) out[key] = value;
  }
  return stringify(out);
}

/**
 * @param {Record<string, unknown>} doc a parsed document
 * @param {string} file for error messages
 * @returns {Config}
 */
function fromDocument(doc, file) {
  const problems = validate(SCHEMA, doc);
  if (problems.length > 0) throw new ConfigError(file, problems);
  const valid = /** @type {Partial<Config>} */ (doc);
  // Known keys only, in the order they are written: `x-` extensions are the project's, not the kit's.
  /** @type {Config} */
  const config = {
    schema: 1,
    kit: /** @type {string} */ (valid.kit),
    commands: /** @type {Commands} */ (valid.commands),
    specialists: valid.specialists ?? {},
    risk_paths: valid.risk_paths ?? [],
    evidence: valid.evidence ?? {},
    review: /** @type {Config['review']} */ (valid.review),
    models: /** @type {Config['models']} */ (valid.models),
    capacity: /** @type {Config['capacity']} */ (valid.capacity),
    owner_only: /** @type {string[]} */ (valid.owner_only),
  };
  return config;
}
