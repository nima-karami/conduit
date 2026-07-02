import { describe, expect, it } from 'vitest';
import { markdownSanitizeSchema } from '../../webview/md-sanitize';

// Assert directly on the exported schema rather than running hast-util-sanitize (a transitive
// dep of rehype-sanitize we don't declare): the behavior we own is which src protocols the
// schema allows, and that IS the schema object.
describe('markdownSanitizeSchema — image src protocols', () => {
  const srcProtocols = markdownSanitizeSchema.protocols?.src ?? [];

  it('allows data: so an embedded base64 image survives (the agent-report chart scenario)', () => {
    expect(srcProtocols).toContain('data');
  });

  it('allows http/https image sources', () => {
    expect(srcProtocols).toContain('http');
    expect(srcProtocols).toContain('https');
  });

  it('does NOT allow javascript: (XSS stays stripped)', () => {
    expect(srcProtocols).not.toContain('javascript');
  });

  it('keeps the language/math classNames sanitize must preserve before highlight/katex', () => {
    const codeClass = (markdownSanitizeSchema.attributes?.code ?? []).find(
      (r) => Array.isArray(r) && r[0] === 'className',
    ) as unknown[] | undefined;
    // A `language-ts` class must pass the code-className rule (a RegExp entry) so highlight.js
    // still sees the language after sanitize.
    expect(codeClass?.some((x) => x instanceof RegExp && x.test('language-ts'))).toBe(true);
    const span = markdownSanitizeSchema.attributes?.span ?? [];
    expect(JSON.stringify(span)).toContain('math-inline');
  });
});
