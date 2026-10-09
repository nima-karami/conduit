import { describe, expect, it } from 'vitest';
import { planFenceLanguage } from '../../webview/plan-fence-language';

describe('planFenceLanguage', () => {
  it('reads the fence-name table first', () => {
    const table: Record<string, string> = {
      makefile: 'makefile',
      make: 'makefile',
      cmake: 'cmake',
      toml: 'toml',
      diff: 'diff',
      patch: 'diff',
      dotenv: 'dotenv',
      env: 'dotenv',
      gitignore: 'ignore',
      groovy: 'groovy',
      ocaml: 'ocaml',
    };
    for (const [fence, id] of Object.entries(table))
      expect(planFenceLanguage(fence), fence).toBe(id);
  });

  it('falls back to the extension table, then to the fence itself', () => {
    expect(planFenceLanguage('ts')).toBe('typescript');
    expect(planFenceLanguage('py')).toBe('python');
    expect(planFenceLanguage('javascript')).toBe('javascript');
    expect(planFenceLanguage('unknownlang')).toBe('unknownlang');
    expect(planFenceLanguage('constructor')).toBe('constructor');
  });

  it('reads an empty fence as plaintext', () => {
    expect(planFenceLanguage('')).toBe('plaintext');
  });
});
