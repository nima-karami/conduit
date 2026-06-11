/**
 * Slugify: Convert text to stable, URL-safe heading identifiers.
 * - Lowercase, trim, spaces → '-', strip non-alphanumerics except '-',
 *   collapse consecutive '-' to single.
 */

/**
 * Pure slugify: convert text to a slug.
 * - 'Hello World' → 'hello-world'
 * - 'Hello    World' → 'hello-world'
 * - 'hello-world' → 'hello-world'
 * - 'Hello, World!' → 'hello-world'
 * - Leading/trailing spaces and dashes trimmed.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase() // lowercase
    .trim() // trim spaces
    .replace(/\s+/g, '-') // spaces → '-'
    .replace(/[^\w-]/g, '') // strip non-alphanumerics except '-'
    .replace(/-+/g, '-') // collapse consecutive '-'
    .replace(/^-+|-+$/g, ''); // trim leading/trailing dashes
}

/**
 * SlugFactory: stateful factory to generate unique slugs,
 * suffixing duplicates with -1, -2, etc.
 * Counter tracks how many times the slug has been requested (including the original).
 */
export class SlugFactory {
  private seen = new Map<string, number>();

  slug(text: string): string {
    const base = slugify(text);

    // Get current count (0 if first time seeing this slug)
    const count = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, count);

    // First occurrence: return base as-is
    if (count === 1) {
      return base;
    }

    // Duplicates: return base-1, base-2, etc.
    return `${base}-${count - 1}`;
  }
}
