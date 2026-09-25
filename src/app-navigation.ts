function shellKey(u: URL): string {
  const p = /^\/[A-Za-z]:/.test(u.pathname)
    ? `/${u.pathname[1].toLowerCase()}${u.pathname.slice(2)}`
    : u.pathname;
  return `${u.protocol}//${u.host}${p}`;
}

/** True only for the app shell itself: same protocol + host + pathname as indexUrl (query/hash
 *  ignored); a /X:/ drive letter compares case-insensitively. Any parse failure → false. */
export function isAppIndexUrl(url: string, indexUrl: string): boolean {
  try {
    return shellKey(new URL(url)) === shellKey(new URL(indexUrl));
  } catch {
    return false;
  }
}
