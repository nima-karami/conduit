/**
 * Convert text to a stable, URL-safe heading identifier.
 * 'Hello, World!' → 'hello-world'
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Generates unique slugs, suffixing duplicates with -1, -2, etc. */
export class SlugFactory {
  private seen = new Map<string, number>();

  slug(text: string): string {
    const base = slugify(text);

    const count = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, count);

    if (count === 1) {
      return base;
    }
    return `${base}-${count - 1}`;
  }
}
