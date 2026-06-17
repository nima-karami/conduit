import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFile } from '../../src/file-service';
import { imageMime, mediaKindForPath } from '../../src/media-kind';

// ── mediaKindForPath ──────────────────────────────────────────────────────────

describe('mediaKindForPath', () => {
  it('returns "image" for all listed extensions (lower-case)', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']) {
      expect(mediaKindForPath(`photo${ext}`), ext).toBe('image');
    }
  });

  it('is case-insensitive', () => {
    expect(mediaKindForPath('shot.PNG')).toBe('image');
    expect(mediaKindForPath('logo.SVG')).toBe('image');
    expect(mediaKindForPath('anim.GIF')).toBe('image');
    expect(mediaKindForPath('photo.JPEG')).toBe('image');
    expect(mediaKindForPath('icon.ICO')).toBe('image');
  });

  it('returns null for non-image extensions', () => {
    expect(mediaKindForPath('file.ts')).toBeNull();
    expect(mediaKindForPath('README.md')).toBeNull();
    expect(mediaKindForPath('archive.zip')).toBeNull();
    expect(mediaKindForPath('video.mp4')).toBeNull();
  });

  it('returns null for paths with no extension', () => {
    expect(mediaKindForPath('Makefile')).toBeNull();
    expect(mediaKindForPath('noext')).toBeNull();
  });

  it('works with absolute paths', () => {
    expect(mediaKindForPath('C:/images/photo.png')).toBe('image');
    expect(mediaKindForPath('/home/user/logo.svg')).toBe('image');
  });
});

// ── imageMime ─────────────────────────────────────────────────────────────────

describe('imageMime', () => {
  it('maps all image extensions to their correct MIME type', () => {
    expect(imageMime('.png')).toBe('image/png');
    expect(imageMime('.jpg')).toBe('image/jpeg');
    expect(imageMime('.jpeg')).toBe('image/jpeg');
    expect(imageMime('.gif')).toBe('image/gif');
    expect(imageMime('.webp')).toBe('image/webp');
    expect(imageMime('.bmp')).toBe('image/bmp');
    expect(imageMime('.ico')).toBe('image/x-icon');
    expect(imageMime('.avif')).toBe('image/avif');
    expect(imageMime('.svg')).toBe('image/svg+xml');
  });

  it('is case-insensitive', () => {
    expect(imageMime('.PNG')).toBe('image/png');
    expect(imageMime('.SVG')).toBe('image/svg+xml');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(imageMime('.xyz')).toBe('application/octet-stream');
  });
});

// ── readFile image path (size-cap decision) ───────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
}

describe('readFile image path', () => {
  it('returns a base64 data URL for a small image file', async () => {
    const dir = makeTmpDir();
    // Minimal 1×1 PNG (89 bytes — real PNG header so it's a valid image, but the
    // test only checks the DTO shape, not the rendered pixel).
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
        '2e00000000c49444154789c626060600000000400015d95ca890000000049454e44ae426082',
      'hex',
    );
    const f = path.join(dir, 'pixel.png');
    fs.writeFileSync(f, pngBytes);

    const doc = await readFile(f);
    expect(doc.binary).toBe(true);
    expect(doc.content).toBe('');
    expect(doc.image).toBeDefined();
    expect(doc.image?.mime).toBe('image/png');
    expect(doc.image?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(doc.image?.bytes).toBe(pngBytes.length);
    expect(doc.error).toBeUndefined();
  });

  it('returns an error (no image field) when the file exceeds MAX_IMAGE_BYTES', async () => {
    const dir = makeTmpDir();
    // Write a tiny PNG but lie about size by patching the cap — instead, use the
    // exported constant and write a file larger than the default MAX_BYTES but
    // smaller than MAX_IMAGE_BYTES so we can test the cap path directly by
    // passing a cap argument to readFile. We set cap=10 bytes and write 20 bytes.
    const f = path.join(dir, 'big.png');
    // Write a file that is bigger than our test cap (10 bytes).
    fs.writeFileSync(f, Buffer.alloc(20, 0xff));

    // readFile ignores the text cap for images and uses MAX_IMAGE_BYTES, so we
    // must write a real large file OR test via the exported constant. Since we
    // can't afford a 25 MB file in a unit test, we instead test via the helper
    // that mediaKindForPath detects images and that a stat-reported size over
    // MAX_IMAGE_BYTES produces the error. We achieve this by monkey-patching the
    // fs.promises.stat in a controlled way using an import-level spy — but
    // vitest mock is the cleaner path. For simplicity, verify the logic by
    // reading file-service.ts's exported MAX_IMAGE_BYTES and confirming our
    // 20-byte file is well below it (so it succeeds), then verify a stat-capped
    // scenario with a custom test using a real oversized file created with a
    // stream.
    //
    // Instead, we verify the success path above and the error message format by
    // checking that a real file whose stat.size > MAX_IMAGE_BYTES is rejected.
    // Use a sparse file trick: write a file with truncate to avoid allocating disk.
    const bigPath = path.join(dir, 'huge.png');
    const handle = await fs.promises.open(bigPath, 'w');
    // Truncate to MAX_IMAGE_BYTES + 1 creates a sparse file (just metadata).
    await handle.truncate(25 * 1024 * 1024 + 1);
    await handle.close();

    const docBig = await readFile(bigPath);
    expect(docBig.binary).toBe(true);
    expect(docBig.image).toBeUndefined();
    expect(docBig.error).toMatch(/too large/i);
    expect(docBig.error).toMatch(/MB/);
  });

  it('returns a data URL for an SVG file (text file detected by extension)', async () => {
    const dir = makeTmpDir();
    const svgContent =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const f = path.join(dir, 'icon.svg');
    fs.writeFileSync(f, svgContent, 'utf8');

    const doc = await readFile(f);
    expect(doc.binary).toBe(true);
    expect(doc.image?.mime).toBe('image/svg+xml');
    expect(doc.image?.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
