// @ts-check
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from './lib/exec.js';
import { ConfigError, loadConfig } from './lib/config.js';
import { runShell } from './lib/shell.js';
import { runDispatch } from './commands/dispatch.js';
import { exitCodeFor, runDoctor } from './commands/doctor.js';
import { runEvidence } from './commands/evidence.js';
import { exitCodeFor as gateExitCode, runGates } from './commands/gate.js';
import { formatInitReport, parseInitArgs, runInit } from './commands/init.js';
import { runReview } from './commands/review.js';
import { runRoutines } from './commands/routines.js';
import { runRun } from './commands/run.js';
import { runState } from './commands/state.js';
import { formatReport, parseTrustedMergeArgs, runTrustedMerge } from './commands/trusted-merge.js';
import { annotate, readState, reconcile, start, transition } from './lib/state-branch.js';

/**
 * @typedef {{ write: (text: string) => unknown }} Writable
 * @typedef {{ stdout: Writable, stderr: Writable }} Io
 */

const USAGE = `Usage: nunnarivu <command> [options]

Commands:
  doctor [--json]                    Check whether this machine is ready for nunnarivu factory
  init [--repo <dir>] --check <cmd> --test <cmd> [--test-scoped <cmd>] [--e2e <cmd>] [--fmt <cmd>]
       [--weekly-budget-usd <n>] [--risk-path <glob>]... [--owner-only <action>]... [--json]
                                     Configure a repository: write nunnarivu.yml, the kit copy at
                                     .nunnarivu/ and the gates and trusted-merge workflows
                                     (exit 0 written, 1 refused, 2 malformed command line)
  gate [--repo <dir>] [--timeout-minutes <n>] [--json]
                                     Run the repository's check and test commands, and its evidence, as gates
  evidence check [--repo <dir>] [--base <sha>] [--issue <n>] [--json]
                                     Check the package record's evidence.json with the checker nunnarivu.yml names
  config validate [--repo <dir>]     Validate the repository's nunnarivu.yml
  state show [<issue>]               Print the work-package state (or one package) as JSON
  state transition <issue> --to <station> [--head <sha>] [--run <url>]
        [--claim <glob>]... [--lease-minutes <n>] [--reason <text>]
                                     One atomic transition on the state branch
  state start <issue> --station <station> [--lease-minutes <n>]
                                     Mark the package waiting at the station as started (run_url pending)
  state annotate <issue> [--run <url>] [--head <sha>] [--done]
                                     Record a package's run link and/or head, or that its session is done
  state reconcile                    Return started packages past their lease to ready
  review validate <review.json>      Validate a reviewer's findings; print the kept and discarded ones
  review score --gates <gates.json> --evidence present|missing --review <review.json>
        --bar <n> --max-rounds <n> [--json]
                                     Compute the round's score and decide merge, fix, retry or blocked
  run <issue> --station <station> [--skill <name>] [--repo <dir>] [--issue-title <text>]
        [--issue-body-file <file>] [--check <command>] [--test <command>] [--json]
                                     Start one session for a package waiting at the station (isolate:
                                     from ready) and print its create_session request (cloud sessions only)
  dispatch plan [--repo <dir>] [--rate-limit <status>] [--json]
                                     Plan one dispatch round: the sessions to start (station and skill),
                                     the packages running and waiting, and whether the rate limit pauses
                                     work; starts nothing (exit 0 planned, 1 error, 2 malformed command line)
  routines [--repo <dir>] [--json]   Print the routine definitions (dispatch, pull-request) with this
                                     repository filled in, for the owner to create them
  trusted-merge --head <sha> [--pr <number>] [--require <check>]... [--repo <dir>] [--json]
                                     Verify a pull request's checks, head, paths and state, squash-merge it,
                                     delete its branch and move the package to cleanup (runs in the trusted
                                     workflow; exit 0 merged, 1 refused, 2 error)

Options:
  --repo <dir>                       Repository for init, gate, evidence, config, state, run, dispatch and routines (default: current directory)
  --version                          Print the kit version
  --help                             Show this help
`;

const STATUS_LABEL = { pass: '[pass]', warn: '[warn]', fail: '[fail]', skipped: '[skipped]' };
const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * @param {string[]} argv arguments after the program name
 * @param {Io} io
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io) {
  const [command, ...rest] = argv;

  if (command === '--version' || command === '-v') {
    io.stdout.write(`${kitVersion()}\n`);
    return 0;
  }
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (command === 'doctor') return doctor(rest, io);
  if (command === 'init') return init(rest, io);
  if (command === 'gate') return gate(rest, io);
  if (command === 'config') return config(rest, io);
  if (command === 'evidence') {
    return runEvidence(rest, { cwd: process.cwd(), timeoutMs: DEFAULT_TIMEOUT_MINUTES * 60_000, run: runShell, version: kitVersion(), env: process.env, git: gitOutput }, io);
  }
  if (command === 'review') return runReview(rest, { readFile: (path) => readFileSync(path, 'utf8'), version: kitVersion() }, io);
  if (command === 'state') {
    return runState(rest, { cwd: process.cwd(), now: () => new Date(), branch: { readState, transition, reconcile, annotate, start } }, io);
  }

  if (command === 'dispatch') {
    return runDispatch(rest, { cwd: process.cwd(), readFile: readTextOrNull, git: gitOutput, branch: { readState } }, io);
  }
  if (command === 'routines') {
    return runRoutines(rest, { cwd: process.cwd(), git: gitOutput, templatesDir: fileURLToPath(new URL('../templates/routines/', import.meta.url)) }, io);
  }

  if (command === 'run') {
    return runRun(
      rest,
      {
        cwd: process.cwd(),
        now: () => new Date(),
        env: process.env,
        readFile: readTextOrNull,
        git: gitOutput,
        skillsDir: fileURLToPath(new URL('../skills/', import.meta.url)),
        branch: { readState, transition, start },
      },
      io,
    );
  }

  if (command === 'trusted-merge') {
    const parsed = parseTrustedMergeArgs(rest, process.cwd());
    if (!parsed.ok) {
      io.stderr.write(`${parsed.error}\n\n${USAGE}`);
      return 2;
    }
    const gh = process.env.NUNNARIVU_GH || 'gh';
    const result = runTrustedMerge(
      { gh: (args) => exec(gh, args), git: (args) => exec('git', args), env: process.env, now: new Date(), state: { readState, transition } },
      parsed.options,
    );
    io.stdout.write(parsed.json ? `${JSON.stringify(result.report, null, 2)}\n` : formatReport(result.report));
    return result.code;
  }

  io.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

/** @param {string[]} args @param {Io} io */
function init(args, io) {
  const parsed = parseInitArgs(args, process.cwd());
  if (!parsed.ok) {
    io.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const report = runInit(
    { now: () => new Date(), pluginDir: fileURLToPath(new URL('../', import.meta.url)), version: kitVersion() },
    parsed.options,
  );
  for (const reason of report.refusals) io.stderr.write(`${reason}\n`);
  io.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatInitReport(report));
  return report.ok ? 0 : 1;
}

/** @param {string[]} args @param {Io} io */
function doctor(args, io) {
  const checks = runDoctor({
    exec,
    platform: process.platform,
    nodeVersion: process.version,
    env: process.env,
    readFile: readTextOrNull,
    cwd: process.cwd(),
    kitVersion: kitVersion(),
  });
  if (args.includes('--json')) {
    io.stdout.write(`${JSON.stringify({ version: kitVersion(), checks }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      io.stdout.write(`${STATUS_LABEL[check.status]} ${check.title}: ${check.detail}\n`);
    }
  }
  return exitCodeFor(checks);
}

/** @param {string[]} args @param {Io} io */
async function gate(args, io) {
  const options = parseOptions(args, ['repo', 'timeout-minutes'], ['json'], io);
  if (!options) return 2;
  const minutes = options.values['timeout-minutes'] === undefined ? DEFAULT_TIMEOUT_MINUTES : Number(options.values['timeout-minutes']);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    io.stderr.write(`--timeout-minutes must be a positive number\n`);
    return 2;
  }
  let gates;
  try {
    gates = await runGates({ repo: resolve(options.values.repo ?? '.'), timeoutMs: minutes * 60_000, run: runShell });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  if (options.flags.json) {
    io.stdout.write(`${JSON.stringify({ version: kitVersion(), gates }, null, 2)}\n`);
    return gateExitCode(gates);
  }
  for (const g of gates) {
    const detail = g.status === 'skipped' ? '(no command)' : `${g.command} (${g.exit_code === null ? 'stopped' : `exit ${g.exit_code}`}, ${g.duration_ms} ms)`;
    io.stdout.write(`${STATUS_LABEL[g.status]} ${g.name}: ${detail}\n`);
  }
  for (const g of gates) {
    if (g.status !== 'fail') continue;
    io.stderr.write(`--- ${g.name} failed ---\n`);
    if (g.stdout_tail) io.stderr.write(`${g.stdout_tail}\n`);
    if (g.stderr_tail) io.stderr.write(`${g.stderr_tail}\n`);
  }
  return gateExitCode(gates);
}

/** @param {string[]} args @param {Io} io */
function config(args, io) {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'validate') {
    io.stderr.write(`Usage: nunnarivu config validate [--repo <dir>]\n`);
    return 2;
  }
  const options = parseOptions(rest, ['repo'], [], io);
  if (!options) return 2;
  try {
    loadConfig(resolve(options.values.repo ?? '.'));
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  io.stdout.write('ok\n');
  return 0;
}

/**
 * Parses `--name value` options and `--flag` switches; anything else is an error.
 *
 * @param {string[]} args
 * @param {string[]} valued option names that take a value
 * @param {string[]} switches option names that take none
 * @param {Io} io
 * @returns {{ values: Record<string, string | undefined>, flags: Record<string, boolean> } | null}
 */
function parseOptions(args, valued, switches, io) {
  /** @type {Record<string, string | undefined>} */
  const values = {};
  /** @type {Record<string, boolean>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name !== null && switches.includes(name)) {
      flags[name] = true;
    } else if (name !== null && valued.includes(name)) {
      const value = args[++i];
      if (value === undefined) {
        io.stderr.write(`--${name} needs a value\n`);
        return null;
      }
      values[name] = value;
    } else {
      io.stderr.write(`Unknown option: ${arg}\n\n${USAGE}`);
      return null;
    }
  }
  return { values, flags };
}

/**
 * Reads the version from the plugin manifest, which lives inside the plugin
 * directory (a plugin cannot read files outside it once installed).
 *
 * @returns {string}
 */
export function kitVersion() {
  const manifest = JSON.parse(
    readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  );
  return String(manifest.version);
}

/**
 * Runs a read-only git command in a repository and returns its output; throws
 * with stderr when it fails.
 *
 * @param {string} cwd @param {string[]} args
 */
function gitOutput(cwd, args) {
  const result = exec('git', ['-C', cwd, ...args]);
  if (!result.ok) throw new Error(`git ${args[0]} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/** @param {string} path @returns {string | null} */
function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
