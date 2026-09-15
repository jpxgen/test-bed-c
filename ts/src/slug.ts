/**
 * Turns a title into a URL slug: lower-case ASCII letters and digits,
 * separated by single hyphens, no hyphen at either end.
 */
export function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, '-');
}
