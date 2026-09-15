/**
 * Turns a title into a URL slug: lower-case ASCII letters and digits,
 * separated by single hyphens, no hyphen at either end.
 *
 * Accented letters fold to their plain base letters: the title is put
 * through Unicode NFD decomposition and the combining diacritical marks
 * U+0300-U+036F are dropped. Every run of characters that are not ASCII
 * letters or digits then becomes one hyphen, so punctuation, whitespace,
 * letters with no ASCII base (such as "ß" or "ø") and any combining mark
 * outside that block all act as separators. A title with no letters or
 * digits gives the empty string.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
