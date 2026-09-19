import { describe, expect, it } from 'vitest';
import { CONDUIT_VERSION } from '../../src/conduit-store';
import type { PlanBlock } from '../../src/plan-blocks';
import { splitPlan } from '../../src/plan-blocks';
import {
  type AnchoredComment,
  applyPlanCommentPatch,
  commentsFingerprint,
  diceSimilarity,
  isPlanComment,
  MAX_COMMENT_TEXT,
  MAX_COMMENTS,
  mergeComments,
  newCommentId,
  type PlanAnchor,
  type PlanComment,
  type PlanCommentsData,
  reanchorComments,
  restorePlanComments,
  serializePlanComments,
} from '../../src/plan-comments';
import { contentHash } from '../../src/review-marks';

const NOW = '2026-09-19T10:00:00.000Z';

function anchor(over: Partial<PlanAnchor> = {}): PlanAnchor {
  return { index: 0, hash: contentHash('# Heading'), snippet: '# Heading', ...over };
}

function comment(over: Partial<PlanComment> = {}): PlanComment {
  return {
    id: 'c1',
    author: 'human',
    text: 'why this shape?',
    anchor: anchor(),
    status: 'open',
    createdAt: NOW,
    ...over,
  };
}

function data(over: Partial<PlanCommentsData> = {}): PlanCommentsData {
  return { version: 1, comments: [], ...over };
}

function blocksOf(markdown: string): PlanBlock[] {
  return splitPlan(markdown).blocks;
}

describe('newCommentId', () => {
  it('is `c` + base36 clock + 4 random base36 chars', () => {
    const id = newCommentId(1758276000000);
    expect(id.startsWith(`c${(1758276000000).toString(36)}`)).toBe(true);
    expect(id).toHaveLength(1 + (1758276000000).toString(36).length + 4);
    expect(id).toMatch(/^c[0-9a-z]+$/);
  });

  it('does not collide on the same clock', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCommentId(1)));
    expect(ids.size).toBeGreaterThan(150);
  });
});

describe('isPlanComment', () => {
  it('accepts a well-formed comment and the optional fields', () => {
    expect(isPlanComment(comment())).toBe(true);
    expect(isPlanComment(comment({ replyTo: 'c0', sentAt: NOW, status: 'resolved' }))).toBe(true);
  });

  it('rejects malformed shapes', () => {
    expect(isPlanComment(null)).toBe(false);
    expect(isPlanComment('c1')).toBe(false);
    expect(isPlanComment({ ...comment(), author: 'robot' })).toBe(false);
    expect(isPlanComment({ ...comment(), status: 'closed' })).toBe(false);
    expect(isPlanComment({ ...comment(), anchor: { index: 0, hash: 'x' } })).toBe(false);
    expect(isPlanComment({ ...comment(), anchor: { index: '0', hash: 'x', snippet: 'y' } })).toBe(
      false,
    );
    const { text: _dropped, ...noText } = comment();
    expect(isPlanComment(noText)).toBe(false);
  });
});

describe('applyPlanCommentPatch', () => {
  it('add then resolve then delete round-trips', () => {
    const empty = data();
    const added = applyPlanCommentPatch(empty, { type: 'add', comment: comment() });
    expect(added.comments).toHaveLength(1);
    expect(added.comments[0].text).toBe('why this shape?');
    expect(empty.comments).toHaveLength(0);

    const resolved = applyPlanCommentPatch(added, { type: 'resolve', id: 'c1', resolved: true });
    expect(resolved.comments[0].status).toBe('resolved');
    expect(added.comments[0].status).toBe('open');

    const reopened = applyPlanCommentPatch(resolved, {
      type: 'resolve',
      id: 'c1',
      resolved: false,
    });
    expect(reopened.comments[0].status).toBe('open');

    const deleted = applyPlanCommentPatch(reopened, { type: 'delete', id: 'c1' });
    expect(deleted.comments).toEqual([]);
  });

  it('edits text and reattaches an anchor', () => {
    const d = applyPlanCommentPatch(data(), { type: 'add', comment: comment() });
    const edited = applyPlanCommentPatch(d, { type: 'edit', id: 'c1', text: 'clearer question' });
    expect(edited.comments[0].text).toBe('clearer question');

    const moved = applyPlanCommentPatch(edited, {
      type: 'reattach',
      id: 'c1',
      anchor: anchor({ index: 3, hash: 'deadbeef', snippet: '## Other' }),
    });
    expect(moved.comments[0].anchor).toEqual({
      index: 3,
      hash: 'deadbeef',
      snippet: '## Other',
    });
  });

  it('refusals return the same object', () => {
    const d = applyPlanCommentPatch(data(), { type: 'add', comment: comment() });

    expect(applyPlanCommentPatch(d, { type: 'edit', id: 'nope', text: 'x' })).toBe(d);
    expect(applyPlanCommentPatch(d, { type: 'delete', id: 'nope' })).toBe(d);
    expect(applyPlanCommentPatch(d, { type: 'resolve', id: 'nope', resolved: true })).toBe(d);
    expect(applyPlanCommentPatch(d, { type: 'reattach', id: 'nope', anchor: anchor() })).toBe(d);

    expect(applyPlanCommentPatch(d, { type: 'edit', id: 'c1', text: 'x'.repeat(4097) })).toBe(d);
    expect(applyPlanCommentPatch(d, { type: 'edit', id: 'c1', text: '   ' })).toBe(d);
    expect(
      applyPlanCommentPatch(d, {
        type: 'add',
        comment: comment({ id: 'c2', text: 'x'.repeat(MAX_COMMENT_TEXT + 1) }),
      }),
    ).toBe(d);
    expect(applyPlanCommentPatch(d, { type: 'add', comment: comment() })).toBe(d);
    expect(
      applyPlanCommentPatch(d, {
        type: 'add',
        comment: { ...comment({ id: 'c3' }), author: 'robot' } as unknown as PlanComment,
      }),
    ).toBe(d);

    expect(applyPlanCommentPatch(d, { type: 'resolve', id: 'c1', resolved: false })).toBe(d);
    const resolved = applyPlanCommentPatch(d, { type: 'resolve', id: 'c1', resolved: true });
    expect(applyPlanCommentPatch(resolved, { type: 'resolve', id: 'c1', resolved: true })).toBe(
      resolved,
    );
  });

  it('refuses an add at MAX_COMMENTS', () => {
    const full = data({
      comments: Array.from({ length: MAX_COMMENTS }, (_, i) => comment({ id: `c${i}` })),
    });
    expect(applyPlanCommentPatch(full, { type: 'add', comment: comment({ id: 'over' }) })).toBe(
      full,
    );

    const oneShort = data({ comments: full.comments.slice(1) });
    expect(
      applyPlanCommentPatch(oneShort, { type: 'add', comment: comment({ id: 'over' }) }).comments,
    ).toHaveLength(MAX_COMMENTS);
  });

  it('sent stamps sentAt on the ids and stores the baseline', () => {
    const d = data({
      comments: [comment({ id: 'c1' }), comment({ id: 'c2' }), comment({ id: 'c3' })],
      baseline: { at: '2026-09-18T00:00:00.000Z', blockHashes: ['old'] },
    });
    const baseline = { at: NOW, blockHashes: ['h1', 'h2'] };
    const sent = applyPlanCommentPatch(d, { type: 'sent', ids: ['c1', 'c3'], baseline });

    expect(sent.comments.map((c) => c.sentAt)).toEqual([NOW, undefined, NOW]);
    expect(sent.baseline).toEqual(baseline);
    expect(d.baseline).toEqual({ at: '2026-09-18T00:00:00.000Z', blockHashes: ['old'] });
  });

  it('sent replaces the baseline wholesale, it does not merge it', () => {
    const d = data({ baseline: { at: '2026-09-18T00:00:00.000Z', blockHashes: ['a', 'b', 'c'] } });
    const sent = applyPlanCommentPatch(d, {
      type: 'sent',
      ids: [],
      baseline: { at: NOW, blockHashes: ['z'] },
    });
    expect(sent.baseline).toEqual({ at: NOW, blockHashes: ['z'] });
  });
});

describe('mergeComments', () => {
  it('keeps local-only ids, takes disk status for shared ids, and picks text by author', () => {
    const local = data({
      comments: [
        comment({ id: 'shared-human', author: 'human', text: 'local human text' }),
        comment({ id: 'shared-agent', author: 'agent', text: 'local agent text' }),
        comment({ id: 'local-only', text: 'only here' }),
      ],
    });
    const disk = data({
      comments: [
        comment({
          id: 'shared-agent',
          author: 'agent',
          text: 'disk agent text',
          status: 'resolved',
          replyTo: 'root',
          sentAt: NOW,
        }),
        comment({
          id: 'shared-human',
          author: 'human',
          text: 'disk human text',
          status: 'resolved',
        }),
        comment({ id: 'disk-only', text: 'from disk' }),
      ],
    });

    const merged = mergeComments(local, disk);

    expect(merged.comments.map((c) => c.id)).toEqual([
      'shared-agent',
      'shared-human',
      'disk-only',
      'local-only',
    ]);
    const byId = new Map(merged.comments.map((c) => [c.id, c]));
    expect(byId.get('shared-human')?.text).toBe('local human text');
    expect(byId.get('shared-human')?.status).toBe('resolved');
    expect(byId.get('shared-agent')?.text).toBe('disk agent text');
    expect(byId.get('shared-agent')?.status).toBe('resolved');
    expect(byId.get('shared-agent')?.replyTo).toBe('root');
    expect(byId.get('shared-agent')?.sentAt).toBe(NOW);
  });

  it('prefers the local baseline and falls back to disk', () => {
    const localBaseline = { at: NOW, blockHashes: ['local'] };
    const diskBaseline = { at: NOW, blockHashes: ['disk'] };
    expect(
      mergeComments(data({ baseline: localBaseline }), data({ baseline: diskBaseline })).baseline,
    ).toEqual(localBaseline);
    expect(mergeComments(data(), data({ baseline: diskBaseline })).baseline).toEqual(diskBaseline);
    expect(mergeComments(data(), data()).baseline).toBeUndefined();
  });
});

describe('diceSimilarity', () => {
  it('is 1 for equal strings and for strings equal after normalization', () => {
    expect(diceSimilarity('hello there', 'hello there')).toBe(1);
    expect(diceSimilarity('  hello\r\nthere  ', 'hello\nthere')).toBe(1);
    expect(diceSimilarity('a', 'a')).toBe(1);
    expect(diceSimilarity('', '')).toBe(1);
  });

  it('is 0 for nothing in common and stays within 0..1', () => {
    expect(diceSimilarity('abcdef', 'uvwxyz')).toBe(0);
    expect(diceSimilarity('abc', '')).toBe(0);
    const partial = diceSimilarity('the quick brown fox', 'the quick brown cat');
    expect(partial).toBeGreaterThan(0.6);
    expect(partial).toBeLessThan(1);
  });
});

describe('reanchorComments', () => {
  const doc = [
    '# Alpha heading',
    '',
    'Some prose about the alpha section of the document.',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '## Omega heading',
    '',
  ].join('\n');

  it('exact hash wins over index, even when the stored index is a perfect snippet match', () => {
    // blocks[0] is a verbatim copy of the snippet, so the index rung would fire at dice 1.0 —
    // only a hash-first ladder lands on 2.
    const twins = [
      '# Alpha heading',
      '',
      'Filler paragraph in between.',
      '',
      '# Alpha heading moved here',
      '',
    ].join('\n');
    const blocks = blocksOf(twins);
    expect(diceSimilarity('# Alpha heading', blocks[0].snippet)).toBe(1);
    const c = comment({
      anchor: { index: 0, hash: blocks[2].hash, snippet: '# Alpha heading' },
    });
    expect(reanchorComments([c], blocks)).toEqual<AnchoredComment[]>([{ comment: c, index: 2 }]);
  });

  it('takes the lowest index when the same hash appears twice', () => {
    const twice = ['Repeated paragraph.', '', 'Middle.', '', 'Repeated paragraph.', ''].join('\n');
    const blocks = blocksOf(twice);
    expect(blocks[0].hash).toBe(blocks[2].hash);
    const c = comment({ anchor: { index: 2, hash: blocks[2].hash, snippet: blocks[2].snippet } });
    expect(reanchorComments([c], blocks)[0].index).toBe(0);
  });

  it('an edited block re-anchors by index when dice >= 0.6', () => {
    const blocks = blocksOf(doc.replace('# Alpha heading', '# Alpha heading revised'));
    const c = comment({
      anchor: { index: 0, hash: 'stale000', snippet: '# Alpha heading' },
    });
    expect(reanchorComments([c], blocks)[0].index).toBe(0);
  });

  it('a block that moved re-anchors to the nearest index within two', () => {
    const moved = ['Filler one.', '', '# Alpha heading', '', 'Filler two.', ''].join('\n');
    const blocks = blocksOf(moved);
    const c = comment({ anchor: { index: 2, hash: 'stale000', snippet: '# Alpha heading' } });
    expect(reanchorComments([c], blocks)[0].index).toBe(1);
  });

  it('a tie at equal distance goes to the lower index', () => {
    const twins = [
      '# Alpha heading one',
      '',
      'Unrelated filler paragraph.',
      '',
      '# Alpha heading one',
      '',
    ].join('\n');
    const blocks = blocksOf(twins);
    const c = comment({
      anchor: { index: 1, hash: 'stale000', snippet: '# Alpha heading one' },
    });
    expect(reanchorComments([c], blocks)[0].index).toBe(0);
  });

  it('a rewritten block detaches (index null)', () => {
    const rewritten = blocksOf(
      ['Completely different wording now.', '', 'Nothing alike whatsoever.', ''].join('\n'),
    );
    const c = comment({
      anchor: { index: 0, hash: 'stale000', snippet: '# Alpha heading' },
    });
    expect(reanchorComments([c], rewritten)).toEqual<AnchoredComment[]>([
      { comment: c, index: null },
    ]);
  });

  it('an out-of-range index with no similar neighbour detaches', () => {
    const blocks = blocksOf(doc);
    const c = comment({ anchor: { index: 99, hash: 'stale000', snippet: 'vanished block' } });
    expect(reanchorComments([c], blocks)[0].index).toBeNull();
  });

  it('never drops a comment', () => {
    const blocks = blocksOf(doc);
    const cs = [comment({ id: 'a' }), comment({ id: 'b', anchor: anchor({ index: 42 }) })];
    expect(reanchorComments(cs, blocks).map((a) => a.comment.id)).toEqual(['a', 'b']);
  });
});

describe('serialize / restore', () => {
  it('writes a plan-comments envelope, 2-space JSON, one trailing newline', () => {
    const d = data({ comments: [comment()], baseline: { at: NOW, blockHashes: ['h'] } });
    const text = serializePlanComments(d);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "kind": "plan-comments"');
    const parsed = JSON.parse(text);
    expect(parsed.conduit).toBe(CONDUIT_VERSION);
    expect(parsed.kind).toBe('plan-comments');
    expect(typeof parsed.updatedAt).toBe('number');
    expect(parsed.data).toEqual(d);
    expect(restorePlanComments(text)).toEqual(d);
  });

  it('tolerates a bare payload and drops malformed entries', () => {
    const bare = JSON.stringify({
      version: 1,
      baseline: { at: NOW, blockHashes: ['h'] },
      comments: [comment({ id: 'good' }), { id: 'bad' }, null, 'nope'],
    });
    const restored = restorePlanComments(bare);
    expect(restored.comments.map((c) => c.id)).toEqual(['good']);
    expect(restored.baseline).toEqual({ at: NOW, blockHashes: ['h'] });
  });

  it('absent, unparseable or foreign payloads restore to an empty set', () => {
    const empty = { version: 1, comments: [] };
    expect(restorePlanComments(undefined)).toEqual(empty);
    expect(restorePlanComments('')).toEqual(empty);
    expect(restorePlanComments('{not json')).toEqual(empty);
    expect(restorePlanComments('[]')).toEqual(empty);
    expect(restorePlanComments(JSON.stringify({ version: 2, comments: [] }))).toEqual(empty);
    expect(restorePlanComments(JSON.stringify({ version: 1, comments: 'x' }))).toEqual(empty);
  });

  it('drops a malformed baseline rather than persisting it', () => {
    const restored = restorePlanComments(
      JSON.stringify({ version: 1, baseline: { at: 5, blockHashes: 'nope' }, comments: [] }),
    );
    expect(restored.baseline).toBeUndefined();
  });
});

describe('commentsFingerprint', () => {
  it('ignores the envelope updatedAt', () => {
    const d = data({ comments: [comment()], baseline: { at: NOW, blockHashes: ['h'] } });
    const a = serializePlanComments(d);
    const b = JSON.stringify(
      { ...JSON.parse(a), updatedAt: JSON.parse(a).updatedAt + 10_000 },
      null,
      2,
    );
    expect(commentsFingerprint(restorePlanComments(a))).toBe(
      commentsFingerprint(restorePlanComments(b)),
    );
  });

  it('changes when a comment or the baseline changes', () => {
    const d = data({ comments: [comment()] });
    expect(commentsFingerprint(d)).not.toBe(
      commentsFingerprint(data({ comments: [comment({ text: 'other' })] })),
    );
    expect(commentsFingerprint(d)).not.toBe(
      commentsFingerprint(data({ comments: [comment()], baseline: { at: NOW, blockHashes: [] } })),
    );
  });
});
