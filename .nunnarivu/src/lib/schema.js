// @ts-check
/**
 * A validator for the JSON Schema (draft 2020-12) keywords that the schemas
 * in `schemas/` use (decision NF-011). Every problem is reported, with a
 * JSON-pointer path. A keyword this validator does not implement is an
 * error, so a schema file cannot silently outgrow it.
 */

/**
 * @typedef {'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null'} TypeName
 * @typedef {{
 *   $schema?: string,
 *   $id?: string,
 *   title?: string,
 *   description?: string,
 *   type?: TypeName | TypeName[],
 *   const?: unknown,
 *   enum?: unknown[],
 *   properties?: Record<string, Schema>,
 *   required?: string[],
 *   additionalProperties?: boolean,
 *   patternProperties?: Record<string, Schema>,
 *   pattern?: string,
 *   items?: Schema,
 *   minItems?: number,
 *   minimum?: number,
 *   maximum?: number,
 * }} Schema
 */

const DOCUMENTATION = new Set(['$schema', '$id', 'title', 'description']);
const KEYWORDS = new Set([
  ...DOCUMENTATION,
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'pattern',
  'items',
  'minItems',
  'minimum',
  'maximum',
]);
/** @type {Record<TypeName, string>} */
const TYPE_WORD = {
  object: 'an object',
  array: 'an array',
  string: 'a string',
  integer: 'an integer',
  number: 'a number',
  boolean: 'a boolean',
  null: 'null',
};

/**
 * @param {Schema} schema
 * @param {unknown} value
 * @returns {string[]} every problem, as `<path>: <what is wrong>`; empty when valid
 * @throws {Error} when the schema uses a keyword or type this validator does not implement
 */
export function validate(schema, value) {
  /** @type {string[]} */
  const problems = [];
  check(schema, '/', value, '/', problems);
  return problems;
}

/**
 * @param {Schema} schema
 * @param {string} schemaPath where `schema` sits in the root schema, for error messages
 * @param {unknown} value
 * @param {string} path JSON pointer to `value` (`/` for the root)
 * @param {string[]} problems
 */
function check(schema, schemaPath, value, path, problems) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`unsupported schema at ${schemaPath}: expected an object`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword)) throw new Error(`unsupported schema keyword "${keyword}" at ${schemaPath}`);
  }

  if (schema.type !== undefined) {
    const types = typeNames(schema.type, schemaPath);
    if (!types.some((type) => hasType(value, type))) {
      problems.push(`${path}: must be ${listWords(types.map((type) => TYPE_WORD[type]))}`);
      return; // the remaining keywords assume the type
    }
  }
  if (schema.const !== undefined && !sameConstant(value, schema.const)) {
    problems.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw new Error(`unsupported enum at ${schemaPath}: expected an array`);
    if (!schema.enum.some((allowed) => sameConstant(value, allowed))) {
      problems.push(`${path}: must be one of ${schema.enum.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')}`);
    }
  }
  if (typeof value === 'number') checkRange(schema, value, path, problems);
  if (typeof value === 'string' && schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw new Error(`pattern must be a string at ${schemaPath}`);
    if (!new RegExp(schema.pattern).test(value)) problems.push(`${path}: must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) checkArray(schema, schemaPath, value, path, problems);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    checkObject(schema, schemaPath, /** @type {Record<string, unknown>} */ (value), path, problems);
  }
}

/** @param {Schema} schema @param {number} value @param {string} path @param {string[]} problems */
function checkRange(schema, value, path, problems) {
  const { minimum, maximum } = schema;
  if (minimum !== undefined && typeof minimum !== 'number') throw new Error('minimum must be a number');
  if (maximum !== undefined && typeof maximum !== 'number') throw new Error('maximum must be a number');
  const tooLow = minimum !== undefined && value < minimum;
  const tooHigh = maximum !== undefined && value > maximum;
  if (!tooLow && !tooHigh) return;
  const word = hasIntegerType(schema) ? 'an integer' : 'a number';
  if (minimum !== undefined && maximum !== undefined) {
    problems.push(`${path}: must be ${word} between ${minimum} and ${maximum}`);
  } else if (tooLow) {
    problems.push(`${path}: must be ${word} of at least ${minimum}`);
  } else {
    problems.push(`${path}: must be ${word} of at most ${maximum}`);
  }
}

/**
 * @param {Schema} schema
 * @param {string} schemaPath
 * @param {unknown[]} value
 * @param {string} path
 * @param {string[]} problems
 */
function checkArray(schema, schemaPath, value, path, problems) {
  if (schema.minItems !== undefined) {
    if (typeof schema.minItems !== 'number') throw new Error(`minItems must be a number at ${schemaPath}`);
    if (value.length < schema.minItems) {
      problems.push(`${path}: must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    }
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => check(/** @type {Schema} */ (schema.items), child(schemaPath, 'items'), item, child(path, String(index)), problems));
  }
}

/**
 * @param {Schema} schema
 * @param {string} schemaPath
 * @param {Record<string, unknown>} value
 * @param {string} path
 * @param {string[]} problems
 */
function checkObject(schema, schemaPath, value, path, problems) {
  const properties = schema.properties ?? {};
  for (const [key, subschema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      check(subschema, child(child(schemaPath, 'properties'), key), value[key], child(path, key), problems);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new Error(`required must be an array at ${schemaPath}`);
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) problems.push(`${path}: missing required key ${key}`);
    }
  }
  const patterns = Object.entries(schema.patternProperties ?? {}).map(([pattern, subschema]) => ({
    pattern,
    regex: new RegExp(pattern),
    subschema,
  }));
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    throw new Error(`unsupported additionalProperties at ${schemaPath}: only true or false is supported`);
  }
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) continue;
    const matching = patterns.filter((p) => p.regex.test(key));
    for (const { pattern, subschema } of matching) {
      check(subschema, child(child(schemaPath, 'patternProperties'), pattern), value[key], child(path, key), problems);
    }
    if (matching.length === 0 && schema.additionalProperties === false) {
      problems.push(`${child(path, key)}: unknown key`);
    }
  }
}

/**
 * @param {unknown} type the `type` keyword: one name or a non-empty list
 * @param {string} schemaPath
 * @returns {TypeName[]}
 */
function typeNames(type, schemaPath) {
  const names = Array.isArray(type) ? type : [type];
  if (names.length === 0) throw new Error(`unsupported type at ${schemaPath}: the list is empty`);
  for (const name of names) {
    if (typeof name !== 'string' || !(name in TYPE_WORD)) {
      throw new Error(`unsupported type "${String(name)}" at ${schemaPath}`);
    }
  }
  return /** @type {TypeName[]} */ (names);
}

/** Whether a number this schema accepts must be an integer. @param {Schema} schema */
function hasIntegerType(schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes('integer') && !types.includes('number');
}

/** `a, b or c` @param {string[]} words */
function listWords(words) {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** @param {unknown} value @param {TypeName} type */
function hasType(value, type) {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

/** Deep equality for JSON values. @param {unknown} a @param {unknown} b @returns {boolean} */
function sameConstant(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = /** @type {Record<string, unknown>} */ (a);
  const rb = /** @type {Record<string, unknown>} */ (b);
  return ka.every((k) => Object.hasOwn(rb, k) && sameConstant(ra[k], rb[k]));
}

/** @param {string} path @param {string} key */
function child(path, key) {
  const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
  return path === '/' ? `/${escaped}` : `${path}/${escaped}`;
}
