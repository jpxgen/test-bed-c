// @ts-check

/**
 * Extracts the first `major.minor.patch` version from tool output,
 * e.g. "2.1.270 (Claude Code)" or "git version 2.51.0.windows.1".
 *
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * @param {string} found tool output containing a version
 * @param {string} minimum version like "2.1.270"
 * @returns {boolean}
 */
export function isAtLeast(found, minimum) {
  const f = parseVersion(found);
  const m = parseVersion(minimum);
  if (!f || !m) return false;
  return compareVersions(f, m) >= 0;
}
