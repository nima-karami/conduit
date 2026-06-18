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

  /** Clear dedup state so a fresh render produces identical, stable ids. A factory
   *  reused across React re-renders would otherwise re-suffix every heading each
   *  render (`x` → `x-1` → `x-2`), breaking anchors and the outline's scraped ids. */
  reset(): void {
    this.seen.clear();
  }

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
