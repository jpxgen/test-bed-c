import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';

test('words become hyphenated lower case', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('surrounding and repeated whitespace collapses', () => {
  assert.equal(slugify('  spaced   out '), 'spaced-out');
});
