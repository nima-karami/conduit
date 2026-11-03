export function changelogSection(markdown: string, version: string): string | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => {
    const heading = /^## \[([^\]]+)\](?:\s+.*)?$/.exec(line);
    return heading?.[1] === version;
  });
  if (headingIndex < 0) return null;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^## \[/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  const body = lines
    .slice(headingIndex + 1, endIndex)
    .join('\n')
    .trim();
  return body || null;
}
