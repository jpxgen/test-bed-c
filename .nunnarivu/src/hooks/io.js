// @ts-check
/**
 * What every hook shares (architecture §4, §10): reading the JSON input
 * Claude Code writes on stdin, the context it injects into a hook's pure
 * `run(input, ctx)`, the one output shape a hook prints, and the script
 * wrapper that never exits with anything but 0 and prints nothing on the
 * hook's own failure — a hook is advisory and fails open.
 *
 * Shapes are those of the Claude Code hooks reference
 * (https://code.claude.com/docs/en/hooks): the input carries the common
 * fields (`cwd`, `hook_event_name`, ...) plus the event's own; context that
 * does not block is `{ hookSpecificOutput: { hookEventName, additionalContext } }`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {Record<string, unknown>} HookInput the parsed stdin JSON
 * @typedef {{ hookSpecificOutput: { hookEventName: string, additionalContext: string } }} HookOutput
 * @typedef {{
 *   readFile: (path: string) => string | null,
 *   git: (cwd: string, args: string[]) => string,
 * }} HookContext `readFile` gives null for a missing file; `git` returns stdout trimmed and throws on failure
 * @typedef {(input: HookInput, ctx: HookContext) => HookOutput | null} Hook
 */

const GIT_TIMEOUT_MS = 3_000;

/**
 * The context a hook runs with: the file system and a read-only git runner
 * with a short timeout, so a hook stays inside its own 5-second budget.
 *
 * @returns {HookContext}
 */
export function hookContext() {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    git: (cwd, args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(),
  };
}

/**
 * The stdin text as the hook input: a JSON object, or null for anything
 * else (empty, malformed, an array, a scalar).
 *
 * @param {string} text
 * @returns {HookInput | null}
 */
export function parseInput(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The directory the hook judges: the input's `cwd` (the directory Claude is
 * working in, per the reference), else the process's.
 *
 * @param {HookInput} input
 */
export function cwdOf(input) {
  return typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
}

/**
 * Context for Claude that blocks nothing.
 *
 * @param {string} hookEventName
 * @param {string} additionalContext
 * @returns {HookOutput}
 */
export function contextOutput(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

/**
 * Reads a stream to its end.
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export function readStdin(stream) {
  return new Promise((resolve) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
    });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}

/**
 * Whether the module at `metaUrl` is the script Node was started with.
 *
 * @param {string} metaUrl the module's `import.meta.url`
 * @param {string[]} argv `process.argv`
 */
export function isMain(metaUrl, argv) {
  const script = argv[1];
  if (script === undefined) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === metaUrl;
  } catch {
    return false;
  }
}

/**
 * Runs a hook as a script: stdin in, the output object (if any) printed as
 * one line of JSON, exit 0 whatever happens — an error in the hook is the
 * hook's problem, never the action's (§4).
 *
 * @param {Hook} run
 * @param {{ stdin: NodeJS.ReadableStream, stdout: { write: (text: string) => unknown } }} [io]
 * @returns {Promise<0>}
 */
export async function main(run, io = { stdin: process.stdin, stdout: process.stdout }) {
  /** @type {HookOutput | null} */
  let output = null;
  try {
    const input = parseInput(await readStdin(io.stdin));
    if (input !== null) output = run(input, hookContext());
  } catch {
    output = null;
  }
  if (output !== null) {
    try {
      io.stdout.write(`${JSON.stringify(output)}\n`);
    } catch {
      // Nothing to do: the action goes through either way.
    }
  }
  return 0;
}

/**
 * The script bottom every hook shares: run when started as a script, and
 * pin the exit code to 0 even if the promise rejects.
 *
 * @param {string} metaUrl
 * @param {Hook} run
 */
export function runAsScript(metaUrl, run) {
  if (!isMain(metaUrl, process.argv)) return;
  process.exitCode = 0;
  main(run).catch(() => {
    process.exitCode = 0;
  });
}
