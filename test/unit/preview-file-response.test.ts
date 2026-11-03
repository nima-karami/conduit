import * as fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { previewFileResponse } from '../../electron/preview-protocol';

describe('previewFileResponse', () => {
  it('streams the file with its type and length, without a whole-file readFile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfr-'));
    const file = join(dir, 'a.html');
    const content = 'x'.repeat(200_000);
    writeFileSync(file, content);
    const read = vi.spyOn(fs.promises, 'readFile');
    try {
      const res = await previewFileResponse(file, 'text/html; charset=utf-8');
      expect(read).not.toHaveBeenCalled();
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-length')).toBe(String(content.length));
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toBe(content);
    } finally {
      read.mockRestore();
    }
  });

  it('rejects for an unreadable file so the handler can answer 500', async () => {
    await expect(
      previewFileResponse(join(tmpdir(), 'pfr-missing', 'nope'), 'text/plain'),
    ).rejects.toThrow();
  });
});
