/**
 * Pure logic for navigating between diff changes.
 * Given a list of change start lines (sorted ascending) and a current line,
 * compute the next/previous target line, with wrapping.
 */

/**
 * Find the next change line after the current position, wrapping to the first if needed.
 * If there are no changes, returns the current line unchanged.
 *
 * @param changeLines - sorted array of change start line numbers
 * @param currentLine - current cursor line number
 * @returns next change line, or current line if empty list
 */
export function nextChange(changeLines: number[], currentLine: number): number {
  if (changeLines.length === 0) return currentLine;

  // Find the first change strictly after currentLine
  const next = changeLines.find((line) => line > currentLine);
  // If found, return it; otherwise wrap to the first change
  return next ?? changeLines[0];
}

/**
 * Find the previous change line before the current position, wrapping to the last if needed.
 * If there are no changes, returns the current line unchanged.
 *
 * @param changeLines - sorted array of change start line numbers
 * @param currentLine - current cursor line number
 * @returns previous change line, or current line if empty list
 */
export function prevChange(changeLines: number[], currentLine: number): number {
  if (changeLines.length === 0) return currentLine;

  // Find the last change strictly before currentLine
  let prev = changeLines[0];
  for (const line of changeLines) {
    if (line >= currentLine) break;
    prev = line;
  }
  // If we haven't advanced, we're before the first change; wrap to the last
  if (prev === changeLines[0] && changeLines[0] >= currentLine) {
    return changeLines[changeLines.length - 1];
  }
  return prev;
}
