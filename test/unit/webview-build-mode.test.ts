import { describe, expect, it } from 'vitest';
import { webBuild } from '../../esbuild.mjs';

describe('renderer build mode', () => {
  it('bundles React for production', () => {
    expect(webBuild('out').define?.['process.env.NODE_ENV']).toBe('"production"');
  });
});
