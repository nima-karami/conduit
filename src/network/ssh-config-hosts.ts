// The Host aliases an ssh config names, for the Add dialog's list. Include is not followed: the
// dialog's text field covers a host that only an included file names (spec 4.1).

/** A Host line: the keyword, then a space or `=`, then its patterns. */
const HOST_LINE = /^host(?:\s*=\s*|\s+)(.+)$/i;

/** Patterns ssh matches many hosts with, or negates; neither names a single machine. */
const isConcreteAlias = (token: string): boolean =>
  !token.startsWith('!') && !token.includes('*') && !token.includes('?');

export function parseSshConfigHosts(text: string): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = HOST_LINE.exec(raw.trim());
    if (match === null) continue;
    for (const token of (match[1] ?? '').split(/\s+/)) {
      if (token === '' || !isConcreteAlias(token) || seen.has(token)) continue;
      seen.add(token);
      hosts.push(token);
    }
  }
  return hosts;
}
