// @ts-check
/**
 * The YAML subset the kit reads and writes (decision NF-011; architecture §9):
 * a top-level block mapping whose values are scalars or flow-style
 * collections, plus comments and blank lines. Everything else is rejected
 * with the line it appears on. Nothing is guessed: a plain scalar that
 * another YAML dialect could read as a different type must be quoted.
 */

/**
 * A value in the subset; nested values are again YamlValue (JSDoc cannot
 * express the recursion, so collections are typed with `unknown` members).
 * @typedef {null | boolean | number | string | unknown[] | YamlMapping} YamlValue
 * @typedef {Record<string, unknown>} YamlMapping
 */

/** A key that can be written without quotes, at the top level or in a flow mapping. */
const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const TOP_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ ]+(.*))?$/;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;
/** Forms that some YAML dialect reads as a non-string; the kit refuses them unquoted. */
const AMBIGUOUS = [
  /^(?:~|null|true|false|yes|no|on|off|y|n)$/i,
  /^[-+]?\.(?:inf|nan)$/i,
  /^[-+]?0[xob][0-9a-f_]+$/i,
  /^[-+]?[0-9_.]+(?:[eE][-+]?[0-9]+)?$/,
  /^[-+]?[0-9]+:[0-9]/,
];
/** Characters that begin something the subset does not read as a plain scalar. */
const INDICATORS = new Set(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`']);
/** Characters a plain scalar may not contain anywhere. */
const NOT_IN_PLAIN = /[,\[\]{}#:"'\\]/;

export class YamlError extends Error {
  /** @param {number} line 1-based @param {string} detail */
  constructor(line, detail) {
    super(`line ${line}: ${detail}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

/**
 * Parses a document in the subset.
 *
 * @param {string} text
 * @returns {YamlMapping}
 * @throws {YamlError} naming the first line outside the subset
 */
export function parse(text) {
  /** @type {YamlMapping} */
  const doc = {};
  const lines = text.split(/\r?\n/);
  /** @type {{ key: string, line: number } | null} */
  let pendingEmpty = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (raw.includes('\t')) throw new YamlError(lineNo, 'tabs are not allowed');
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw)) throw new YamlError(lineNo, 'control characters are not allowed');
    const line = stripComment(raw, lineNo);
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      throw new YamlError(lineNo, 'indented lines are not supported: nested values must be flow style ({ } or [ ])');
    }
    if (pendingEmpty) throw new YamlError(pendingEmpty.line, `key "${pendingEmpty.key}" has no value`);

    const match = TOP_LINE.exec(line.trimEnd());
    if (!match) throw new YamlError(lineNo, 'expected "key: value"');
    const [, key, valueText] = match;
    if (Object.hasOwn(doc, key)) throw new YamlError(lineNo, `duplicate key "${key}"`);
    if (valueText === undefined || valueText.trim() === '') {
      pendingEmpty = { key, line: lineNo };
      continue;
    }
    const cursor = new Cursor(valueText.trim(), lineNo);
    const value = cursor.value(false);
    cursor.skipSpaces();
    if (!cursor.atEnd()) throw new YamlError(lineNo, `unexpected text after value: "${cursor.rest()}"`);
    doc[key] = value;
  }
  if (pendingEmpty) throw new YamlError(pendingEmpty.line, `key "${pendingEmpty.key}" has no value`);
  return doc;
}

/**
 * Removes a `#` comment (a `#` at the line start or after a space, outside
 * quotes). The line is otherwise returned unchanged.
 *
 * @param {string} line
 * @param {number} lineNo
 */
function stripComment(line, lineNo) {
  /** @type {'"' | "'" | null} */
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || line[i - 1] === ' ')) {
      return line.slice(0, i);
    }
  }
  if (quote) throw new YamlError(lineNo, `unterminated ${quote === '"' ? 'double' : 'single'}-quoted string`);
  return line;
}

/** Recursive-descent reader over one line's value text. */
class Cursor {
  /** @param {string} text @param {number} line */
  constructor(text, line) {
    this.text = text;
    this.pos = 0;
    this.line = line;
  }

  /** @param {string} detail @returns {never} */
  fail(detail) {
    throw new YamlError(this.line, detail);
  }

  atEnd() {
    return this.pos >= this.text.length;
  }

  peek() {
    return this.text[this.pos];
  }

  rest() {
    return this.text.slice(this.pos);
  }

  skipSpaces() {
    while (this.text[this.pos] === ' ') this.pos++;
  }

  /**
   * @param {boolean} inFlow whether `,`, `]` and `}` end a plain scalar
   * @returns {YamlValue}
   */
  value(inFlow) {
    this.skipSpaces();
    const ch = this.peek();
    if (ch === undefined) this.fail('expected a value');
    if (ch === '{') return this.flowMapping();
    if (ch === '[') return this.flowSequence();
    if (ch === '"') return this.doubleQuoted();
    if (ch === "'") return this.singleQuoted();
    return this.plain(inFlow);
  }

  /** @returns {YamlMapping} */
  flowMapping() {
    this.pos++; // {
    /** @type {YamlMapping} */
    const result = {};
    for (;;) {
      this.skipSpaces();
      if (this.atEnd()) this.fail('unterminated flow mapping: missing "}"');
      if (this.peek() === '}') {
        this.pos++;
        return result;
      }
      const key = this.key();
      if (Object.hasOwn(result, key)) this.fail(`duplicate key "${key}"`);
      if (this.peek() !== ':' || !(this.text[this.pos + 1] === ' ' || this.text[this.pos + 1] === undefined)) {
        this.fail(`expected ": " after key "${key}"`);
      }
      this.pos++; // :
      result[key] = this.value(true);
      this.skipSpaces();
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() === '}') continue;
      if (this.atEnd()) this.fail('unterminated flow mapping: missing "}"');
      this.fail(`expected "," or "}" in flow mapping, found "${this.peek()}"`);
    }
  }

  /** @returns {YamlValue[]} */
  flowSequence() {
    this.pos++; // [
    /** @type {YamlValue[]} */
    const result = [];
    for (;;) {
      this.skipSpaces();
      if (this.atEnd()) this.fail('unterminated flow sequence: missing "]"');
      if (this.peek() === ']') {
        this.pos++;
        return result;
      }
      result.push(this.value(true));
      this.skipSpaces();
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() === ']') continue;
      if (this.atEnd()) this.fail('unterminated flow sequence: missing "]"');
      this.fail(`expected "," or "]" in flow sequence, found "${this.peek()}"`);
    }
  }

  /** A flow-mapping key: quoted, or plain in the same form as a top-level key. */
  key() {
    const ch = this.peek();
    if (ch === '"') return this.doubleQuoted();
    if (ch === "'") return this.singleQuoted();
    const match = /^[A-Za-z0-9_][A-Za-z0-9_.-]*/.exec(this.rest());
    if (!match) this.fail(`expected a key in flow mapping, found "${this.rest()}"`);
    this.pos += match[0].length;
    return match[0];
  }

  doubleQuoted() {
    this.pos++; // "
    let out = '';
    for (;;) {
      const ch = this.text[this.pos++];
      if (ch === undefined) this.fail('unterminated double-quoted string');
      if (ch === '"') return out;
      if (ch === '\\') {
        const next = this.text[this.pos++];
        if (next === '"' || next === '\\') out += next;
        else this.fail(`unsupported escape "\\${next ?? ''}" in double-quoted string (only \\" and \\\\)`);
      } else {
        out += ch;
      }
    }
  }

  singleQuoted() {
    this.pos++; // '
    const end = this.text.indexOf("'", this.pos);
    if (end === -1) this.fail('unterminated single-quoted string');
    const out = this.text.slice(this.pos, end);
    this.pos = end + 1;
    return out;
  }

  /** @param {boolean} inFlow @returns {YamlValue} */
  plain(inFlow) {
    const start = this.pos;
    const first = this.peek();
    if (INDICATORS.has(first) && !(first === '-' && /[^\s]/.test(this.text[this.pos + 1] ?? ''))) {
      this.fail(`a value cannot start with "${first}" (anchors, aliases, tags, block scalars and block collections are not supported; quote the string if it is one)`);
    }
    let end = this.text.length;
    if (inFlow) {
      const stop = /[,\]}]/.exec(this.rest());
      if (stop) end = start + stop.index;
    }
    const text = this.text.slice(start, end).trimEnd();
    this.pos = start + text.length;
    if (text === '') this.fail('expected a value');
    const bad = NOT_IN_PLAIN.exec(text);
    if (bad) this.fail(`unquoted value "${text}" contains "${bad[0]}"; quote it`);
    return scalarOf(text, this.line);
  }
}

/**
 * @param {string} text a trimmed plain scalar
 * @param {number} line
 * @returns {YamlValue}
 */
function scalarOf(text, line) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (INTEGER.test(text) || DECIMAL.test(text)) return Number(text);
  if (AMBIGUOUS.some((re) => re.test(text))) {
    throw new YamlError(line, `unquoted value "${text}" could be read as another type; quote it`);
  }
  return text;
}

/**
 * Writes a mapping in the subset: top-level keys one per line, nested values
 * in flow style, strings quoted when needed. `parse(stringify(v))` deep-equals `v`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stringify(value) {
  if (!isMapping(value)) throw new TypeError('the top-level value must be a mapping');
  let out = '';
  for (const [key, entry] of Object.entries(value)) {
    if (!PLAIN_KEY.test(key)) throw new TypeError(`key "${key}" cannot be written at the top level`);
    out += `${key}: ${flow(entry, `/${key}`)}\n`;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} path for error messages
 * @returns {string}
 */
function flow(value, path) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    const text = String(value);
    if (!Number.isFinite(value) || !(INTEGER.test(text) || DECIMAL.test(text))) {
      throw new TypeError(`${path}: number ${text} cannot be written`);
    }
    return text;
  }
  if (typeof value === 'string') return string(value, path);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map((v, i) => flow(v, `${path}/${i}`)).join(', ')}]`;
  }
  if (isMapping(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, v]) => `${PLAIN_KEY.test(k) ? k : string(k, path)}: ${flow(v, `${path}/${k}`)}`).join(', ')} }`;
  }
  throw new TypeError(`${path}: a ${typeof value} cannot be written`);
}

/** @param {string} value @param {string} path */
function string(value, path) {
  if (/[\r\n]/.test(value)) throw new TypeError(`${path}: a string containing a newline cannot be written`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${path}: a string containing a control character cannot be written`);
  if (isPlainSafe(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** @param {string} value */
function isPlainSafe(value) {
  if (value === '' || /\s/.test(value)) return false;
  if (NOT_IN_PLAIN.test(value)) return false;
  const first = value[0];
  if (INDICATORS.has(first) && !(first === '-' && value.length > 1)) return false;
  if (value === 'true' || value === 'false' || value === 'null') return false;
  if (INTEGER.test(value) || DECIMAL.test(value)) return false;
  return !AMBIGUOUS.some((re) => re.test(value));
}

/** @param {unknown} value @returns {value is YamlMapping} */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
