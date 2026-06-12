import { describe, expect, it } from 'vitest';
import { flattenOmni, type OmniInputs, rankOmniResults } from '../../src/omni-search';

const inputs: OmniInputs = {
  sessions: [
    { id: 's1', title: 'portfolio dev', subtitle: 'nextjs-portfolio' },
    { id: 's2', title: 'api server', subtitle: 'backend' },
  ],
  agents: [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex CLI' },
  ],
  files: [
    { abs: '/p/app/page.tsx', rel: 'app/page.tsx' },
    { abs: '/p/components/Hero.tsx', rel: 'components/Hero.tsx' },
    { abs: '/p/lib/util.ts', rel: 'lib/util.ts' },
  ],
};

describe('rankOmniResults', () => {
  it('returns all three groups in fixed order for an empty query', () => {
    const groups = rankOmniResults('', inputs);
    expect(groups.map((g) => g.kind)).toEqual(['session', 'agent', 'file']);
    expect(groups.map((g) => g.label)).toEqual(['Sessions', 'Agents', 'Files']);
    // Empty query = idle listing in incoming order, score 0.
    expect(groups[0].results.map((r) => r.title)).toEqual(['portfolio dev', 'api server']);
    expect(groups[0].results.every((r) => r.score === 0)).toBe(true);
  });

  it('matches sessions by title', () => {
    const groups = rankOmniResults('portfolio', inputs);
    const session = groups.find((g) => g.kind === 'session');
    expect(session?.results.map((r) => r.title)).toEqual(['portfolio dev']);
  });

  it('matches agents by name', () => {
    const groups = rankOmniResults('codex', inputs);
    const agent = groups.find((g) => g.kind === 'agent');
    expect(agent?.results.map((r) => r.title)).toEqual(['Codex CLI']);
  });

  it('matches files by relative path', () => {
    const groups = rankOmniResults('hero', inputs);
    const files = groups.find((g) => g.kind === 'file');
    expect(files?.results.map((r) => r.title)).toEqual(['components/Hero.tsx']);
  });

  it('searches across all kinds at once and drops empty groups', () => {
    // "co" is a subsequence of "Codex CLI", "Claude Code", and "components/Hero.tsx",
    // but not of any session title here.
    const groups = rankOmniResults('co', inputs);
    expect(groups.map((g) => g.kind).sort()).toEqual(['agent', 'file']);
    expect(groups.find((g) => g.kind === 'session')).toBeUndefined();
  });

  it('returns no groups when nothing matches', () => {
    expect(rankOmniResults('zzzzz', inputs)).toEqual([]);
  });

  it('ranks better fuzzy matches first within a group', () => {
    const groups = rankOmniResults('page', inputs);
    const files = groups.find((g) => g.kind === 'file');
    expect(files?.results[0].title).toBe('app/page.tsx');
  });

  it('carries stable kind-prefixed ids and routing kind', () => {
    const groups = rankOmniResults('claude', inputs);
    const agent = groups.find((g) => g.kind === 'agent')?.results[0];
    expect(agent?.id).toBe('agent:claude');
    expect(agent?.kind).toBe('agent');
  });

  it('caps each group at the per-group limit', () => {
    const many: OmniInputs = {
      sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, title: `session ${i}` })),
      agents: [],
      files: [],
    };
    const groups = rankOmniResults('session', many);
    expect(groups[0].results.length).toBe(30);
  });
});

describe('flattenOmni', () => {
  it('flattens groups preserving group order for keyboard nav', () => {
    const groups = rankOmniResults('', inputs);
    const flat = flattenOmni(groups);
    // sessions (2) + agents (2) + files (3) = 7, in that order
    expect(flat.length).toBe(7);
    expect(flat[0].kind).toBe('session');
    expect(flat[2].kind).toBe('agent');
    expect(flat[4].kind).toBe('file');
  });

  it('returns an empty array for no groups', () => {
    expect(flattenOmni([])).toEqual([]);
  });
});
