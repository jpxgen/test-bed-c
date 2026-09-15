# Work package 2

Slugs keep accents and punctuation

## Acceptance criteria

- [ ] `slugify('Crème Brûlée')` returns `'creme-brulee'`: accented letters fold to their plain base letters before slugging.
- [ ] `slugify('Hello, World!')` returns `'hello-world'`: every run of characters that are neither letters nor digits becomes a single hyphen.
- [ ] `slugify('--Already--Slugged--')` returns `'already-slugged'`: no hyphen at either end, however the title starts or ends, and interior runs of hyphens collapse to one.
- [ ] `slugify('Hello World')` still returns `'hello-world'`, and `slugify('  spaced   out ')` still returns `'spaced-out'`: plain titles and whitespace collapsing are unchanged.
- [ ] The result contains only lower-case ASCII letters, digits and single interior hyphens: `slugify('Ünïcode & Numbers 123')` returns `'unicode-numbers-123'`.
- [ ] A title with no letters or digits at all, such as `'!!!'` or `''`, returns the empty string `''`. (assumption)
- [ ] Letters that have no plain ASCII base letter under Unicode decomposition, such as `'ß'` or `'ø'`, are treated as non-letters and become a hyphen: `slugify('Straße')` returns `'stra-e'`. (assumption)
- [ ] The existing tests in `ts/test/slug.test.ts` keep passing, and `make check` and `make test` pass.

## Write set

ts/src/slug.ts
ts/test/slug.test.ts
nunnarivu/wp-2/

## Evidence

type: logic
