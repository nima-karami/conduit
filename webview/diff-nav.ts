// Navigate between diff changes. `changeLines` is sorted ascending; navigation
// wraps. An empty list returns `currentLine` unchanged.

export function nextChange(changeLines: number[], currentLine: number): number {
  if (changeLines.length === 0) return currentLine;

  const next = changeLines.find((line) => line > currentLine);
  return next ?? changeLines[0]; // wrap to first when past the last change
}

export function prevChange(changeLines: number[], currentLine: number): number {
  if (changeLines.length === 0) return currentLine;

  let prev = changeLines[0];
  for (const line of changeLines) {
    if (line >= currentLine) break;
    prev = line;
  }
  // Before the first change: wrap to the last.
  if (prev === changeLines[0] && changeLines[0] >= currentLine) {
    return changeLines[changeLines.length - 1];
  }
  return prev;
}
