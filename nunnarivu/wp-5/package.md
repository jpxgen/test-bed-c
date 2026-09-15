# Work package 5

Limit the length of a slug

## Acceptance criteria

- [ ] `slugify` takes an optional second argument, `maxLength`, so it is called as `slugify(title, maxLength?)`; every existing one-argument call compiles and behaves as before. (assumption)
- [ ] Without a limit, results are exactly what they are today: `slugify('Hello World')` returns `'hello-world'`, `slugify('Crème Brûlée')` returns `'creme-brulee'`, `slugify('--Already--Slugged--')` returns `'already-slugged'`, `slugify('!!!')` returns `''`, and every case in the existing test file gives the same result as before.
- [ ] With a limit, the result is never longer than the limit and never ends with a hyphen: for every title in the existing test file and every limit from 1 to 30, `slugify(title, limit).length <= limit` and the result does not end with `'-'`.
- [ ] The cut keeps whole words where it can: `slugify('Hello Wonderful World', 10)` returns `'hello'`, `slugify('Hello Wonderful World', 15)` returns `'hello-wonderful'`, and `slugify('Hello Wonderful World', 100)` returns `'hello-wonderful-world'`.
- [ ] A limit that lands exactly on a word or on the hyphen after it keeps that word and drops the hyphen: `slugify('Hello Wonderful World', 5)` and `slugify('Hello Wonderful World', 6)` both return `'hello'`. (assumption)
- [ ] When even the first word is longer than the limit, that word is cut to the limit: `slugify('Wonderful', 3)` returns `'won'`, and `slugify('Hello Wonderful World', 3)` returns `'hel'`.
- [ ] A limit at or above the full slug's length leaves it unchanged: `slugify('Hello World', 11)` returns `'hello-world'`.
- [ ] A title that slugs to the empty string still gives `''` under any valid limit: `slugify('!!!', 5)` returns `''`. (assumption)
- [ ] A limit below one is rejected with an error: `slugify('Hello', 0)` and `slugify('Hello', -1)` throw a `RangeError`, before the title is looked at, so `slugify('', 0)` throws too. (assumption)
- [ ] A limit that is not an integer, including `NaN` and `Infinity`, is rejected with the same `RangeError`. (assumption)
- [ ] The existing tests in `ts/test/slug.test.ts` keep passing, and `make check` and `make test` pass.

## Write set

ts/src/slug.ts
ts/test/slug.test.ts
nunnarivu/wp-5/

## Evidence

type: logic
