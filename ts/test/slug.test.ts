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

// Work package 5: an optional maximum length.
//
// The suite compiles with tsc before it runs, and a compile error would stop
// every test above from running. So the two-argument calls below go through
// this alias, which carries the signature the criteria ask for. Until slugify
// declares the second parameter these tests fail at run time, where they can
// be counted, rather than at compile time.
const slugifyWithLimit = slugify as (title: string, maxLength?: number) => string;

const existingTitles = [
  'Hello World',
  '  spaced   out ',
  'Crème Brûlée',
  'Hello, World!',
  '--Already--Slugged--',
  'Ünïcode & Numbers 123',
  'Straße',
  'Håkon Ørsted',
  '!!!',
  '',
];

test('wp-5: with a limit, the result is never longer than the limit and never ends with a hyphen', () => {
  for (const title of existingTitles) {
    for (let limit = 1; limit <= 30; limit++) {
      const slug = slugifyWithLimit(title, limit);
      const label = `slugify(${JSON.stringify(title)}, ${limit}) = ${JSON.stringify(slug)}`;
      assert.ok(slug.length <= limit, `${label} is longer than ${limit}`);
      assert.ok(!slug.endsWith('-'), `${label} ends with a hyphen`);
    }
  }
});

test('wp-5: the cut keeps whole words where it can', () => {
  assert.equal(slugifyWithLimit('Hello Wonderful World', 10), 'hello');
  assert.equal(slugifyWithLimit('Hello Wonderful World', 15), 'hello-wonderful');
  assert.equal(slugifyWithLimit('Hello Wonderful World', 100), 'hello-wonderful-world');
});

test('wp-5: a limit landing on a word or on the hyphen after it keeps the word and drops the hyphen (assumption)', () => {
  assert.equal(slugifyWithLimit('Hello Wonderful World', 5), 'hello');
  assert.equal(slugifyWithLimit('Hello Wonderful World', 6), 'hello');
});

test('wp-5: when even the first word is longer than the limit, that word is cut to the limit', () => {
  assert.equal(slugifyWithLimit('Wonderful', 3), 'won');
  assert.equal(slugifyWithLimit('Hello Wonderful World', 3), 'hel');
});

test('wp-5: a limit at or above the full slug length leaves it unchanged, one below it cuts', () => {
  assert.equal(slugifyWithLimit('Hello World', 11), 'hello-world');
  assert.equal(slugifyWithLimit('Hello World', 12), 'hello-world');
  assert.equal(slugifyWithLimit('Hello World', 10), 'hello');
});

test('wp-5: a title that slugs to the empty string gives the empty string under a valid limit, and its limit is still checked (assumption)', () => {
  assert.equal(slugifyWithLimit('!!!', 5), '');
  assert.equal(slugifyWithLimit('', 1), '');
  assert.throws(() => slugifyWithLimit('!!!', 0), RangeError);
});

test('wp-5: a limit below one throws a RangeError before the title is looked at (assumption)', () => {
  assert.throws(() => slugifyWithLimit('Hello', 0), RangeError);
  assert.throws(() => slugifyWithLimit('Hello', -1), RangeError);
  assert.throws(() => slugifyWithLimit('', 0), RangeError);
});

test('wp-5: a limit that is not an integer, including NaN and Infinity, throws a RangeError (assumption)', () => {
  assert.throws(() => slugifyWithLimit('Hello', 2.5), RangeError);
  assert.throws(() => slugifyWithLimit('Hello', NaN), RangeError);
  assert.throws(() => slugifyWithLimit('Hello', Infinity), RangeError);
});
