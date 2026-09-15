// @ts-check
/**
 * `nunnarivu init`: the deterministic scaffolding of init-project (KR-19;
 * architecture §3). It writes the project configuration, the project's copy
 * of the kit with its registration (§6 item 5, KR-16) and the two workflow
 * templates — and never touches a file it does not own.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILE, ConfigError, configText, parseConfig } from '../lib/config.js';
import { parse as parseYaml, YamlError } from '../lib/yaml.js';

/** The project's copy of the kit, relative to the repository root. */
export const KIT_DIR = '.nunnarivu';
/** The registration a hook checks before doing anything, inside KIT_DIR. */
export const REGISTRATION_FILE = 'registration.json';
/** Workflow templates copied into `.github/workflows/`. */
export const WORKFLOWS = Object.freeze(['gates.yml', 'trusted-merge.yml']);
/** Plugin paths that stay out of the project's copy: the environment's setup script. */
const NOT_COPIED = new Set(['cloud/setup.sh']);
const WORKFLOWS_DIR = '.github/workflows';
const TEMPLATES_DIR = 'templates/workflows';
const MARKER = /^# nunnarivu factory \S+ — managed by init-project; do not edit$/;

/**
 * The first line of a workflow file the kit manages. A file without it is the
 * project's and is never overwritten.
 *
 * @param {string} version full kit version
 */
export const MARKER_LINE = (version) => `# nunnarivu factory ${version} — managed by init-project; do not edit`;

/** @param {string} text a workflow file */
export function hasMarker(text) {
  return MARKER.test(text.split('\n')[0]);
}

/**
 * @typedef {import('../lib/config.js').Config} Config
 * @typedef {import('../lib/config.js').Commands} Commands
 * @typedef {{
 *   repo: string,
 *   commands: Partial<Commands>,
 *   weeklyBudgetUsd: number | undefined,
 *   riskPaths: string[] | undefined,
 *   ownerOnly: string[] | undefined,
 * }} InitOptions
 * @typedef {{ now: () => Date, pluginDir: string, version: string }} InitContext
 * @typedef {'written' | 'unchanged' | 'refused'} FileStatus
 * @typedef {{ path: string, status: FileStatus, detail: string }} FileReport
 * @typedef {{
 *   version: string,
 *   repo: string,
 *   ok: boolean,
 *   files: FileReport[],
 *   refusals: string[],
 *   next_steps: string[],
 * }} InitReport
 */

const VALUED = ['repo', 'check', 'test', 'test-scoped', 'e2e', 'fmt', 'weekly-budget-usd'];
const REPEATED = ['risk-path', 'owner-only'];
/** @type {Record<string, keyof Commands>} */
const COMMAND_FLAGS = { check: 'check', test: 'test', 'test-scoped': 'test_scoped', e2e: 'e2e', fmt: 'fmt' };

/**
 * Parses the arguments after `init`. A malformed command line is an error
 * (exit 2); a missing `--check` or `--test` is a refusal `runInit` reports.
 *
 * @param {string[]} argv
 * @param {string} cwd default repository
 * @returns {{ ok: true, json: boolean, options: InitOptions } | { ok: false, error: string }}
 */
export function parseInitArgs(argv, cwd) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Record<string, string[]>} */
  const lists = { 'risk-path': [], 'owner-only': [] };
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name === null || !(VALUED.includes(name) || REPEATED.includes(name))) {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
    i += 1;
    if (REPEATED.includes(name)) {
      lists[name].push(value);
    } else {
      if (Object.hasOwn(values, name)) return { ok: false, error: `${arg} given twice` };
      values[name] = value;
    }
  }
  /** @type {number | undefined} */
  let weeklyBudgetUsd;
  if (Object.hasOwn(values, 'weekly-budget-usd')) {
    weeklyBudgetUsd = Number(values['weekly-budget-usd']);
    if (!Number.isFinite(weeklyBudgetUsd) || weeklyBudgetUsd < 0 || values['weekly-budget-usd'].trim() === '') {
      return { ok: false, error: `--weekly-budget-usd must be a number of 0 or more, not "${values['weekly-budget-usd']}"` };
    }
  }
  /** @type {Partial<Commands>} */
  const commands = {};
  for (const [flag, key] of Object.entries(COMMAND_FLAGS)) {
    if (Object.hasOwn(values, flag)) commands[key] = values[flag];
  }
  return {
    ok: true,
    json,
    options: {
      repo: resolve(cwd, values.repo ?? '.'),
      commands,
      weeklyBudgetUsd,
      riskPaths: lists['risk-path'].length > 0 ? lists['risk-path'] : undefined,
      ownerOnly: lists['owner-only'].length > 0 ? lists['owner-only'] : undefined,
    },
  };
}

/**
 * Configures the repository. Every refusal is found before anything is
 * written; a refusal writes nothing.
 *
 * @param {InitContext} ctx
 * @param {InitOptions} options
 * @returns {InitReport}
 */
export function runInit(ctx, options) {
  const { repo } = options;
  /** @type {InitReport} */
  const report = { version: ctx.version, repo, ok: false, files: [], refusals: [], next_steps: [] };
  const refuse = (/** @type {string} */ reason) => report.refusals.push(reason);

  if (!existsSync(join(repo, '.git'))) refuse(`${repo} is not a git repository (no .git)`);
  for (const key of /** @type {const} */ (['check', 'test'])) {
    if (options.commands[key] === undefined) refuse(`--${key} <cmd> is required: the project's ${key} command`);
  }

  // The configuration: new from the flags, or the existing one with the given sections replaced.
  const configFile = join(repo, CONFIG_FILE);
  const existing = readTextOrNull(configFile);
  /** @type {string | null} */
  let configOut = null;
  try {
    const config = existing === null ? newConfig(ctx, options) : updatedConfig(existing, configFile, options);
    configOut = configText(config, configFile);
  } catch (error) {
    if (error instanceof ConfigError) refuse(error.message);
    else throw error;
  }

  // Workflows: the kit's (marker) or absent are written; the project's refuse the whole init.
  /** @type {{ path: string, text: string, current: string | null }[]} */
  const workflows = [];
  for (const name of WORKFLOWS) {
    const path = `${WORKFLOWS_DIR}/${name}`;
    const current = readTextOrNull(join(repo, path));
    if (current !== null && !hasMarker(current)) {
      refuse(`${path} exists and was not written by the kit (no marker line); move it aside to let init manage it`);
      continue;
    }
    const template = readFileSync(join(ctx.pluginDir, TEMPLATES_DIR, name), 'utf8');
    const text = hasMarker(template) ? template : `${MARKER_LINE(ctx.version)}\n${template}`;
    workflows.push({ path, text, current });
  }

  if (report.refusals.length > 0 || configOut === null) return report;

  // Nothing refused: write, in order.
  if (existing === configOut) {
    report.files.push({ path: CONFIG_FILE, status: 'unchanged', detail: 'kept as it is' });
  } else {
    writeFileSync(configFile, configOut);
    report.files.push({ path: CONFIG_FILE, status: 'written', detail: existing === null ? 'created from the flags' : 'the given sections replaced' });
  }

  copyKit(ctx.pluginDir, join(repo, KIT_DIR));
  report.files.push({ path: `${KIT_DIR}/`, status: 'written', detail: `kit ${ctx.version} copied` });
  const registration = {
    schema: 1,
    kit: ctx.version,
    registered_at: ctx.now().toISOString(),
    config_sha256: createHash('sha256').update(configOut).digest('hex'),
  };
  writeFileSync(join(repo, KIT_DIR, REGISTRATION_FILE), `${JSON.stringify(registration, null, 2)}\n`);
  report.files.push({ path: `${KIT_DIR}/${REGISTRATION_FILE}`, status: 'written', detail: 'registration for the hooks' });

  mkdirSync(join(repo, WORKFLOWS_DIR), { recursive: true });
  for (const { path, text, current } of workflows) {
    if (current === text) {
      report.files.push({ path, status: 'unchanged', detail: 'already the template' });
      continue;
    }
    writeFileSync(join(repo, path), text);
    report.files.push({ path, status: 'written', detail: current === null ? 'template copied' : 'template refreshed' });
  }

  report.ok = true;
  report.next_steps = [
    `Commit the changes: ${CONFIG_FILE}, ${KIT_DIR}/ and ${WORKFLOWS_DIR}/.`,
    'Protect the default branch: require pull requests with the gates check passing, and forbid force pushes and direct pushes.',
    `Create the routines: run \`nunnarivu routines\` for the dispatch and pull-request definitions filled in for this repository (the templates are in ${KIT_DIR}/templates/routines/) and create each in the Claude Code routines UI.`,
    'Connect the machine identity: a machine user with write access to this repository, held off the default branch by rulesets, whose GitHub account is the one connected to claude.ai (architecture §6 item 1, decision NF-013).',
  ];
  return report;
}

/**
 * @param {InitReport} report
 * @returns {string}
 */
export function formatInitReport(report) {
  let out = '';
  for (const file of report.files) out += `[${file.status}] ${file.path}: ${file.detail}\n`;
  if (!report.ok) return `${out}Refused (${report.refusals.length} reason${report.refusals.length === 1 ? '' : 's'} above); nothing was written.\n`;
  out += '\nNext steps:\n';
  report.next_steps.forEach((step, i) => {
    out += `${i + 1}. ${step}\n`;
  });
  return out;
}

/**
 * @param {InitContext} ctx
 * @param {InitOptions} options
 * @returns {Config}
 */
function newConfig(ctx, options) {
  return {
    schema: 1,
    kit: ctx.version.split('.').slice(0, 2).join('.'),
    commands: {
      check: options.commands.check ?? '',
      test: options.commands.test ?? '',
      test_scoped: options.commands.test_scoped ?? '',
      e2e: options.commands.e2e ?? '',
      fmt: options.commands.fmt ?? '',
    },
    specialists: {},
    risk_paths: riskPaths(options.riskPaths ?? []),
    evidence: { logic: { checker: 'builtin:test-before-after' } },
    review: { bar: 5, max_rounds: 3 },
    models: { low: 'sonnet', medium: 'opus', xhigh: 'opus' },
    capacity: { parallel: 3, weekly_budget_usd: options.weeklyBudgetUsd ?? 0 },
    owner_only: options.ownerOnly ?? [],
  };
}

/**
 * The existing configuration with only the given flags applied; its `x-`
 * extensions ride along.
 *
 * @param {string} text
 * @param {string} file
 * @param {InitOptions} options
 * @returns {Config & Record<string, unknown>}
 * @throws {ConfigError} when the existing file is invalid
 */
function updatedConfig(text, file, options) {
  const config = parseConfig(text, file);
  /** @type {Config & Record<string, unknown>} */
  const updated = {
    ...config,
    commands: { ...config.commands, ...options.commands },
    capacity: { ...config.capacity, weekly_budget_usd: options.weeklyBudgetUsd ?? config.capacity.weekly_budget_usd },
    risk_paths: options.riskPaths === undefined ? config.risk_paths : riskPaths(options.riskPaths),
    owner_only: options.ownerOnly ?? config.owner_only,
  };
  const doc = parseYamlOrThrow(text, file);
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('x-')) updated[key] = value;
  }
  return updated;
}

/** @param {string} text @param {string} file */
function parseYamlOrThrow(text, file) {
  try {
    return parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) throw new ConfigError(file, [error.message]);
    throw error;
  }
}

/** @param {string[]} globs @returns {import('../lib/config.js').RiskPath[]} */
function riskPaths(globs) {
  return globs.map((glob) => ({ glob, tier: 'xhigh', reviewers: ['security-auditor'] }));
}

/**
 * Replaces `dest` with a copy of the plugin directory, all but the
 * environment's setup script. The copy is staged next to `dest` and swapped
 * in, so a plugin that is itself the project's copy is read before it is
 * replaced.
 *
 * @param {string} pluginDir
 * @param {string} dest
 */
function copyKit(pluginDir, dest) {
  const source = resolve(pluginDir);
  const staging = `${dest}.new`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, {
    recursive: true,
    filter: (src) => {
      const path = relative(source, src).split(sep).join('/');
      return !NOT_COPIED.has(path);
    },
  });
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
}

/** @param {string} path @returns {string | null} */
function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
