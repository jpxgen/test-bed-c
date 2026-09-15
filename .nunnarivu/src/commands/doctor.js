// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from '../lib/config.js';
import { isAtLeast, parseVersion } from '../lib/version.js';
import { KIT_DIR, REGISTRATION_FILE } from './init.js';

/** Minimum versions the kit is built and tested against. */
export const MINIMUM = Object.freeze({
  node: '20.0.0',
  git: '2.40.0',
  claude: '2.1.270',
});

/**
 * @typedef {{ version: string, artifact: string, sha256: string }} WheelPin
 * @typedef {{ package: string, version: string, sha512: string }} NpmPin
 * @typedef {{ uv: WheelPin, pnpm: NpmPin, claude: NpmPin & { native: NpmPin } }} Pins
 */

/**
 * Exact toolchain versions the cloud setup script installs, with the hashes
 * it verifies (KR-18). The file lives inside the plugin so that the script,
 * this doctor and CI read the one source.
 *
 * @type {Pins}
 */
export const PINS = Object.freeze(
  JSON.parse(readFileSync(new URL('../../cloud/pins.json', import.meta.url), 'utf8')),
);

/**
 * @typedef {import('../lib/exec.js').Exec} Exec
 * @typedef {'pass' | 'warn' | 'fail' | 'skipped'} Status
 * @typedef {{ id: string, title: string, status: Status, detail: string }} Check
 * @typedef {{
 *   exec: Exec,
 *   platform: string,
 *   nodeVersion: string,
 *   env: Record<string, string | undefined>,
 *   readFile: (path: string) => string | null,
 *   cwd: string,
 *   kitVersion: string,
 * }} DoctorContext
 */

/**
 * Checks whether this session or machine can develop with, and autonomously
 * run, the kit. Autonomous runs happen in cloud sessions (decision NF-009);
 * a development machine passes with a warning on the cloud-session check.
 *
 * @param {DoctorContext} ctx
 * @returns {Check[]}
 */
export function runDoctor(ctx) {
  return [
    checkNode(ctx),
    checkGit(ctx),
    checkGitHubCli(ctx),
    checkClaude(ctx),
    checkPlatform(ctx),
    checkCloud(ctx),
    checkPinned(ctx, 'uv'),
    checkPinned(ctx, 'pnpm'),
    checkRegistration(ctx),
  ];
}

/**
 * @param {Check[]} checks
 * @returns {number} 0 when nothing failed, 1 otherwise
 */
export function exitCodeFor(checks) {
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

/**
 * Cloud sessions set CLAUDE_CODE_REMOTE; the environment type names the
 * Anthropic-hosted or self-hosted environment the session runs in. The one
 * rule `doctor` and `run` share (KR-14, architecture §6 item 4).
 *
 * @param {Record<string, string | undefined>} env
 */
export function isCloudSession(env) {
  return env.CLAUDE_CODE_REMOTE === 'true';
}

/** @param {DoctorContext} ctx */
function inCloudSession(ctx) {
  return isCloudSession(ctx.env);
}

/** @param {DoctorContext} ctx @returns {Check} */
function checkNode(ctx) {
  const ok = isAtLeast(ctx.nodeVersion, MINIMUM.node);
  return {
    id: 'node',
    title: 'Node.js',
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? `${ctx.nodeVersion}`
      : `${ctx.nodeVersion} found; ${MINIMUM.node} or newer is required`,
  };
}

/** @param {DoctorContext} ctx @returns {Check} */
function checkGit(ctx) {
  const result = ctx.exec('git', ['--version']);
  if (!result.ok) {
    return { id: 'git', title: 'git', status: 'fail', detail: 'git is not installed or not on PATH' };
  }
  const ok = isAtLeast(result.stdout, MINIMUM.git);
  return {
    id: 'git',
    title: 'git',
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? versionText(result.stdout)
      : `${versionText(result.stdout)} found; ${MINIMUM.git} or newer is required`,
  };
}

/** @param {DoctorContext} ctx @returns {Check} */
function checkGitHubCli(ctx) {
  const gh = ctx.env.NUNNARIVU_GH || 'gh';
  const version = ctx.exec(gh, ['--version']);
  if (!version.ok) {
    if (inCloudSession(ctx)) {
      return {
        id: 'gh',
        title: 'GitHub CLI',
        status: 'pass',
        detail: 'not installed; GitHub access goes through the session proxy',
      };
    }
    return {
      id: 'gh',
      title: 'GitHub CLI',
      status: 'fail',
      detail: 'GitHub CLI is not installed or not on PATH (set NUNNARIVU_GH to its path if needed)',
    };
  }
  // Only the exit code of `gh auth status` is used; its output can include account details.
  const auth = ctx.exec(gh, ['auth', 'status']);
  return {
    id: 'gh',
    title: 'GitHub CLI',
    status: auth.ok ? 'pass' : 'warn',
    detail: auth.ok
      ? `${versionText(version.stdout)}, logged in`
      : `${versionText(version.stdout)}, not logged in — run: gh auth login`,
  };
}

/** @param {DoctorContext} ctx @returns {Check} */
function checkClaude(ctx) {
  const claude = ctx.env.NUNNARIVU_CLAUDE || 'claude';
  const result = ctx.exec(claude, ['--version']);
  if (!result.ok) {
    return {
      id: 'claude',
      title: 'Claude Code CLI',
      status: 'fail',
      detail: 'Claude Code CLI is not on PATH (set NUNNARIVU_CLAUDE to its path if needed)',
    };
  }
  const ok = isAtLeast(result.stdout, MINIMUM.claude);
  return {
    id: 'claude',
    title: 'Claude Code CLI',
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? versionText(result.stdout)
      : `${versionText(result.stdout)} found; ${MINIMUM.claude} or newer is required`,
  };
}

/** @param {DoctorContext} ctx @returns {Check} */
function checkPlatform(ctx) {
  if (ctx.platform === 'darwin') {
    return { id: 'platform', title: 'Platform', status: 'pass', detail: 'macOS' };
  }
  if (ctx.platform === 'win32') {
    return {
      id: 'platform',
      title: 'Platform',
      status: 'warn',
      detail: 'native Windows supports development only',
    };
  }
  if (ctx.platform === 'linux') {
    const kernel = ctx.readFile('/proc/version') ?? '';
    if (/microsoft/i.test(kernel) && !/wsl2/i.test(kernel)) {
      return {
        id: 'platform',
        title: 'Platform',
        status: 'fail',
        detail: 'WSL1 detected; Claude Code needs WSL2 — run: wsl --set-version <distro> 2',
      };
    }
    return {
      id: 'platform',
      title: 'Platform',
      status: 'pass',
      detail: /wsl2/i.test(kernel) ? 'Linux (WSL2)' : 'Linux',
    };
  }
  return {
    id: 'platform',
    title: 'Platform',
    status: 'fail',
    detail: `unsupported platform: ${ctx.platform}`,
  };
}

/** @param {DoctorContext} ctx @returns {Check} */
function checkCloud(ctx) {
  if (inCloudSession(ctx)) {
    const kind = ctx.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE || 'environment type unknown';
    return { id: 'cloud', title: 'Cloud session', status: 'pass', detail: `cloud session (${kind})` };
  }
  return {
    id: 'cloud',
    title: 'Cloud session',
    status: 'warn',
    detail:
      'not a cloud session — fine for development; autonomous runs and measurement need a cloud session',
  };
}

/**
 * A tool the cloud setup script installs must be at its pinned version. In a
 * cloud session that is a failure (the setup script should have run); on a
 * development machine it is a warning.
 *
 * @param {DoctorContext} ctx
 * @param {'uv' | 'pnpm'} id
 * @returns {Check}
 */
function checkPinned(ctx, id) {
  const pinned = PINS[id].version;
  const notAtPin = inCloudSession(ctx) ? 'fail' : 'warn';
  const fix = 'run: bash plugin/cloud/setup.sh';
  const result = ctx.exec(id, ['--version']);
  if (!result.ok) {
    return { id, title: id, status: notAtPin, detail: `not on PATH; pinned ${pinned} — ${fix}` };
  }
  const found = versionText(result.stdout);
  if (found === pinned) {
    return { id, title: id, status: 'pass', detail: `${pinned} (pinned)` };
  }
  return { id, title: id, status: notAtPin, detail: `${found} found; pinned ${pinned} — ${fix}` };
}

/**
 * In a configured project (one with `nunnarivu.yml` in the current directory),
 * the registration `init` wrote must match the configuration and this kit:
 * hooks stay inert otherwise (KR-16, architecture §6 item 5). Elsewhere the
 * check is skipped.
 *
 * @param {DoctorContext} ctx
 * @returns {Check}
 */
function checkRegistration(ctx) {
  const id = 'registration';
  const title = 'Project registration';
  const config = ctx.readFile(join(ctx.cwd, CONFIG_FILE));
  if (config === null) return { id, title, status: 'skipped', detail: `no ${CONFIG_FILE} here` };
  const path = `${KIT_DIR}/${REGISTRATION_FILE}`;
  const again = 'run: nunnarivu init (or /nunnarivu-factory:init-project) again';
  const text = ctx.readFile(join(ctx.cwd, path));
  if (text === null) return { id, title, status: 'warn', detail: `${CONFIG_FILE} found but no ${path}; hooks stay inert — ${again}` };
  /** @type {{ kit?: unknown, config_sha256?: unknown }} */
  let registration;
  try {
    registration = JSON.parse(text);
  } catch {
    return { id, title, status: 'warn', detail: `${path} is not valid JSON — ${again}` };
  }
  if (registration.config_sha256 !== createHash('sha256').update(config).digest('hex')) {
    return { id, title, status: 'warn', detail: `${CONFIG_FILE} changed since registration; hooks stay inert — ${again}` };
  }
  if (registration.kit !== ctx.kitVersion) {
    return { id, title, status: 'warn', detail: `registered by kit ${String(registration.kit)}, this kit is ${ctx.kitVersion} — ${again}` };
  }
  return { id, title, status: 'pass', detail: `registered by kit ${ctx.kitVersion}; ${CONFIG_FILE} unchanged since` };
}

/** @param {string} output */
function versionText(output) {
  const v = parseVersion(output);
  return v ? v.join('.') : output.split('\n')[0];
}
