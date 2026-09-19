export const PLANS_DIR = '.conduit/plans';
export const PLAN_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const PLAN_PATH_RE = /^(.+)[/\\]\.conduit[/\\]plans[/\\]([^/\\]+)(\.md)$/i;

interface PlanPathParts {
  root: string;
  base: string;
}

function matchPlanPath(path: string): PlanPathParts | null {
  const m = PLAN_PATH_RE.exec(path);
  // The `i` flag covers the directory names only — the extension stays case-sensitive.
  if (!m?.[1] || !m[2] || m[3] !== '.md') return null;
  return { root: m[1], base: m[2] };
}

export function isPlanDocPath(path: string): boolean {
  return matchPlanPath(path) !== null;
}

export function planSlugFromPath(path: string): string | null {
  const parts = matchPlanPath(path);
  if (!parts || !PLAN_SLUG_RE.test(parts.base)) return null;
  return parts.base;
}

export function planRootFromPath(path: string): string | null {
  return matchPlanPath(path)?.root ?? null;
}
