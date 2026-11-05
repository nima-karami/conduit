import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('quit confirm dialog wiring', () => {
  it('app.tsx passes hideCancel and focusClose for the quit-guard confirm', () => {
    const src = readFileSync(join(process.cwd(), 'webview', 'app.tsx'), 'utf8');
    const block = src.slice(
      src.indexOf("kind: 'confirm'"),
      src.indexOf('focusDialog: focusOpenModal'),
    );
    expect(block).toContain('hideCancel: true');
    expect(block).toContain('showClose: true');
    expect(block).toContain('focusClose: true');
    expect(block).not.toContain('focusCancel: true');
  });
});
