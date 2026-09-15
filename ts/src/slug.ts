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
 *
 * An optional `maxLength` caps the slug's length. Without it the result is
 * unchanged. With it the slug is cut at the last hyphen that fits, so whole
 * words are kept where possible and the result never ends with a hyphen;
 * when even the first word is longer than the limit, that word is cut to the
 * limit. A `maxLength` that is not an integer of at least one throws a
 * `RangeError` before the title is looked at.
 */
export function slugify(title: string, maxLength?: number): string {
  if (maxLength !== undefined && (!Number.isInteger(maxLength) || maxLength < 1)) {
    throw new RangeError(`maxLength must be an integer of at least 1, got ${maxLength}`);
  }
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (maxLength === undefined || slug.length <= maxLength) {
    return slug;
  }
  // The character just past the cut is a hyphen when the limit lands on a
  // word end; a hyphen inside the cut marks the last whole word that fits.
  const cut = slug.slice(0, maxLength);
  if (slug[maxLength] === '-') {
    return cut;
  }
  const lastHyphen = cut.lastIndexOf('-');
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
}
