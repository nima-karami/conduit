import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { monacoDompurify } from '../../tools/monaco-dompurify.mjs';

const MIN = [3, 4, 17];

// Bundling Monaco's sanitizer is what proves the vendored 3.2.7 copy is gone; the lockfile alone can't.
describe('monaco dompurify redirect', () => {
  it('bundles the audited dompurify, not the copy vendored in monaco-editor', async () => {
    const out = await build({
      stdin: {
        contents: "import 'monaco-editor/esm/vs/base/browser/domSanitize.js';",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      logLevel: 'silent',
      plugins: [monacoDompurify],
    });
    const code = out.outputFiles[0].text;
    const versions = [...code.matchAll(/DOMPurify (\d+)\.(\d+)\.(\d+)/g)].map((m) =>
      [m[1], m[2], m[3]].map(Number),
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      const [a, b, c] = v;
      const ok = a > MIN[0] || (a === MIN[0] && (b > MIN[1] || (b === MIN[1] && c >= MIN[2])));
      expect(ok, `DOMPurify ${v.join('.')} in bundle`).toBe(true);
    }
  }, 60_000);
});
