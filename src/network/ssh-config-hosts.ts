// The Host aliases an ssh config names, for the Add dialog's list. Include is not followed: the
// dialog's text field covers a host that only an included file names (spec 4.1).

/** A Host line: the keyword, then a space or `=`, then its patterns. */
const HOST_LINE = /^host(?:\s*=\s*|\s+)(.+)$/i;

/** Patterns ssh matches many hosts with, or negates; neither names a single machine. */
const isConcreteAlias = (token: string): boolean =>
  !token.startsWith('!') && !token.includes('*') && !token.includes('?');

/**
 * One Host line's aliases. A `#` token starts a comment that runs to the end of the line; a quoted
 * name is skipped whole, since ssh reads it as one pattern with spaces in it.
 */
function aliasesOf(value: string): string[] {
  const out: string[] = [];
  let inQuote = false;
  for (const token of value.split(/\s+/)) {
    if (token.startsWith('#')) break;
    if (inQuote) {
      inQuote = !token.endsWith('"');
      continue;
    }
    if (token.startsWith('"')) {
      inQuote = token.length === 1 || !token.endsWith('"');
      continue;
    }
    if (token !== '' && isConcreteAlias(token)) out.push(token);
  }
  return out;
}

export function parseSshConfigHosts(text: string): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = HOST_LINE.exec(raw.trim());
    if (match === null) continue;
    for (const alias of aliasesOf(match[1] ?? '')) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      hosts.push(alias);
    }
  }
  return hosts;
}
