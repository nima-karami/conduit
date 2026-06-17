/** Image file extensions, lower-cased. SVG is intentionally included: detect by
 *  extension, not by isBinary, because SVG reads as text and would otherwise fall
 *  into the Monaco editor path. */
const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
  '.svg',
]);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/** Returns `'image'` when the path has a known image extension (case-insensitive),
 *  `null` otherwise. Detection is by extension only — never by content. */
export function mediaKindForPath(filePath: string): 'image' | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return IMAGE_EXTS.has(ext) ? 'image' : null;
}

/** Maps a lower-cased extension (e.g. `'.png'`) to a MIME type string.
 *  Returns `'application/octet-stream'` for unknown extensions. */
export function imageMime(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}
