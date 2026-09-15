// @ts-check
/**
 * PreToolUse hook for Edit, Write and MultiEdit (KR-08, KR-12; architecture
 * §4, §6 item 2): on a package branch `claude/wp-<n>` whose record
 * `nunnarivu/wp-<n>/package.md` has a `## Write set` section, a write to a
 * file outside every glob of that write set, or to a protected path, gets
 * one sentence of context saying so. It never blocks, never decides: the
 * binding rules are the gates, the trusted merge and the isolate station's
 * claim on the state branch.
 *
 * Inert unless the repository is registered (registered.js).
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { currentPackage, recordDir } from '../lib/record.js';
import { contextOutput, cwdOf, runAsScript } from './io.js';
import { isRegistered } from './registered.js';

/** Paths the trusted merge refuses in a pull request; the owner changes them (§6 item 2). */
export const PROTECTED_PATHS = Object.freeze(['.github/', '.nunnarivu/', 'nunnarivu.yml']);

/**
 * @typedef {import('./io.js').HookInput} HookInput
 * @typedef {import('./io.js').HookContext} HookContext
 * @typedef {import('./io.js').HookOutput} HookOutput
 */

/**
 * @param {HookInput} input
 * @param {HookContext} ctx
 * @returns {HookOutput | null}
 */
export function run(input, ctx) {
  try {
    const toolInput = input.tool_input;
    if (toolInput === null || typeof toolInput !== 'object') return null;
    const filePath = /** @type {Record<string, unknown>} */ (toolInput).file_path;
    if (typeof filePath !== 'string' || filePath === '') return null;
    const cwd = cwdOf(input);
    if (!isRegistered(cwd, ctx.readFile)) return null;
    // The checked-out branch only: a hook runs in a session, never in CI, so
    // no GITHUB_HEAD_REF is consulted.
    const issue = currentPackage(cwd, {}, ctx.git);
    if (issue === null) return null;
    const record = `${recordDir(issue)}/package.md`;
    const text = ctx.readFile(resolve(cwd, record));
    if (text === null) return null;
    const writeSet = parseWriteSet(text);
    if (writeSet === null) return null;

    const path = repoPath(cwd, filePath);
    if (path === null) return null;
    if (isProtected(path)) {
      return contextOutput(
        'PreToolUse',
        `${path} is a protected path (${PROTECTED_PATHS.join(', ')}): the trusted merge refuses a pull request that touches it, so that change is the owner's to make (architecture §6 item 2)`,
      );
    }
    if (writeSet.some((glob) => matchesGlob(glob, path))) return null;
    return contextOutput(
      'PreToolUse',
      `${path} is outside the write set of package ${issue} (${writeSet.join(', ')}): the stations after isolate change nothing outside it (${record})`,
    );
  } catch {
    return null;
  }
}

/**
 * The globs of the record's `## Write set` section, one per line, with a
 * list bullet and backticks stripped; null when there is no such section or
 * it is empty.
 *
 * @param {string} packageMd
 * @returns {string[] | null}
 */
export function parseWriteSet(packageMd) {
  const match = /^## Write set[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(packageMd);
  if (!match) return null;
  const globs = match[1]
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^`(.*)`$/, '$1').trim())
    .filter((line) => line !== '');
  return globs.length > 0 ? globs : null;
}

/**
 * Whether a repository-relative path lies in a write-set glob. A glob
 * without wildcards is a whole file or a directory (with or without a
 * trailing `/`) and matches everything under it — the reading `state.js`
 * gives claimed write sets. `**` spans directories, `*` and `?` stay within
 * one path segment.
 *
 * @param {string} glob
 * @param {string} path forward slashes, relative to the repository root
 */
export function matchesGlob(glob, path) {
  const g = glob.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (g === '' || g === '*' || g === '**') return true;
  if (!/[*?[]/.test(g)) return path === g || path.startsWith(`${g}/`);
  return toRegExp(g).test(path);
}

/** @param {string} glob */
function toRegExp(glob) {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

/** @param {string} path repository-relative */
function isProtected(path) {
  return PROTECTED_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/**
 * The file's path relative to the repository with forward slashes, or null
 * when it lies outside the repository (a working file in a temporary
 * directory is not the write set's concern).
 *
 * @param {string} cwd
 * @param {string} filePath
 */
function repoPath(cwd, filePath) {
  const rel = relative(cwd, resolve(cwd, filePath)).split('\\').join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

runAsScript(import.meta.url, run);
