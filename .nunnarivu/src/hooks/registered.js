// @ts-check
/**
 * The check every hook makes first (KR-16; architecture §6 item 5): the
 * repository was registered by `init-project` — `nunnarivu.yml` exists,
 * `.nunnarivu/registration.json` exists — and the configuration is what was
 * registered: its sha256 equals `config_sha256`. Anything else, including a
 * failure to read, is "not registered", and the hook stays inert.
 *
 * `nunnarivu doctor` reports the same conditions as warnings.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { KIT_DIR, REGISTRATION_FILE } from '../commands/init.js';
import { CONFIG_FILE } from '../lib/config.js';

/**
 * @param {string} cwd the directory the hook runs in: the repository root when registered
 * @param {(path: string) => string | null} readFile
 * @returns {boolean}
 */
export function isRegistered(cwd, readFile) {
  try {
    const config = readFile(join(cwd, CONFIG_FILE));
    if (config === null) return false;
    const text = readFile(join(cwd, KIT_DIR, REGISTRATION_FILE));
    if (text === null) return false;
    const registration = JSON.parse(text);
    if (registration === null || typeof registration !== 'object') return false;
    return registration.config_sha256 === createHash('sha256').update(config).digest('hex');
  } catch {
    return false;
  }
}
