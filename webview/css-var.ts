/** Read a CSS custom property off a computed style, falling back when unset/empty. */
export function cssVar(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  return cs.getPropertyValue(name).trim() || fallback;
}
