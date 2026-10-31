/**
 * Pure URL helpers for the in-app web view. The renderer only ever sets a
 * `normalizeUrl`-approved http(s) URL as a `<webview src>` — never a raw user string —
 * so scheme validation lives here and is unit-tested without a DOM.
 */

/** Hosts that should default to http:// (local dev servers, loopback). */
function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

/**
 * Coerce raw address-bar input into a safe http(s) URL, or `null` if it can't be one.
 * - already-schemed http(s) → validated and returned
 * - bare host / host:port / host/path → prefixed (https://, or http:// for loopback)
 * - any other scheme (file:, javascript:, data:, …) → null (never navigated to)
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // An address-bar entry with whitespace isn't a bare URL (and a real URL has none).
  if (/\s/.test(raw)) return null;

  // A leading `scheme:` only counts as a scheme when the char after the colon is NOT a
  // digit — otherwise it's a `host:port` (e.g. `localhost:5173`), not `scheme:rest`.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(raw);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
    try {
      const u = new URL(raw);
      if (!u.hostname) return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  // No scheme — treat as a host(:port)(/path).
  const host = raw.split(/[/?#]/)[0];
  const scheme = isLocalHost(host) ? 'http' : 'https';
  try {
    const u = new URL(`${scheme}://${raw}`);
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Short, human title for a URL (hostname + first path segment), used as the tab label
 *  until the page's real <title> loads. */
export function displayTitleForUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${u.hostname}/${seg}` : u.hostname;
  } catch {
    return url;
  }
}
