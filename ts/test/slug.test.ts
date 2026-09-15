import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';

test('words become hyphenated lower case', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('surrounding and repeated whitespace collapses', () => {
  assert.equal(slugify('  spaced   out '), 'spaced-out');
});

test('accented letters fold to their plain base letters', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});

test('every run of characters that are neither letters nor digits becomes one hyphen', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('no hyphen at either end and interior hyphen runs collapse', () => {
  assert.equal(slugify('--Already--Slugged--'), 'already-slugged');
});

test('result contains only lower-case ASCII letters, digits and single interior hyphens', () => {
  assert.equal(slugify('Ünïcode & Numbers 123'), 'unicode-numbers-123');
  const shape = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  for (const title of [
    'Hello World',
    '  spaced   out ',
    'Crème Brûlée',
    'Hello, World!',
    '--Already--Slugged--',
    'Ünïcode & Numbers 123',
    'Straße',
    'Håkon Ørsted',
  ]) {
    assert.match(slugify(title), shape, `slugify(${JSON.stringify(title)})`);
  }
});

test('a title with no letters or digits gives the empty string (assumption)', () => {
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify(''), '');
});

test('letters with no ASCII base under decomposition become a hyphen (assumption)', () => {
  assert.equal(slugify('Straße'), 'stra-e');
  assert.equal(slugify('Håkon Ørsted'), 'hakon-rsted');
});
