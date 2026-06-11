/**
 * Classify a link's href so the UI can route it non-destructively.
 *
 * - `external` — an absolute http/https URL; open in the user's real browser.
 * - `os`       — another absolute scheme the OS can handle (mailto:, tel:, …);
 *                hand off to the OS rather than navigate the app window.
 * - `ignore`   — empty, hash-only, relative (no scheme), or javascript:;
 *                never open externally and never navigate the app away.
 */
export type LinkKind = 'external' | 'os' | 'ignore';

const OS_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'facetime:']);

export function classifyLink(href: string | null | undefined): LinkKind {
  const raw = (href ?? '').trim();
  if (!raw || raw.startsWith('#')) return 'ignore';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // No scheme / relative / malformed — not something we open externally.
    return 'ignore';
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme === 'http:' || scheme === 'https:') return 'external';
  if (OS_SCHEMES.has(scheme)) return 'os';
  // javascript:, data:, file:, and anything else: do not open or navigate.
  return 'ignore';
}

/** True for hrefs we should hand to the host (real browser / OS handler). */
export function shouldOpenExternally(href: string | null | undefined): boolean {
  const kind = classifyLink(href);
  return kind === 'external' || kind === 'os';
}
