import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRIEF_MAX_BYTES,
  BRIEF_PREVIEW_DIR,
  briefArgs,
  briefBanner,
  briefByteCount,
  briefPreviewArgs,
  briefPrompt,
  decodeBrief,
  decodeBriefText,
  parseBriefField,
  planBriefSpawn,
} from '../../src/role-brief';

const enc = (s: string) => new TextEncoder().encode(s);
// Built from its code point: a literal U+FEFF in source trips the source-bytes guard.
const BOM = String.fromCharCode(0xfeff);
const ctx = { agentsDir: '/cfg', homeDir: '/home/u', resolve: path.posix.resolve };

describe('parseBriefField', () => {
  it('a string is a text source', () => {
    expect(parseBriefField('be terse', ctx)).toEqual({ kind: 'text', text: 'be terse' });
  });
  it('a relative file resolves next to agents.json', () => {
    expect(parseBriefField({ file: 'b.md' }, ctx)).toEqual({ kind: 'file', path: '/cfg/b.md' });
  });
  it('~/ resolves against the home dir', () => {
    expect(parseBriefField({ file: '~/b.md' }, ctx)).toEqual({
      kind: 'file',
      path: '/home/u/b.md',
    });
  });
  it('undefined stays undefined', () => {
    expect(parseBriefField(undefined, ctx)).toBeUndefined();
  });
  it.each([{}, { file: 1 }, { file: 'x', x: 1 }, 7, { file: '' }, null, ['a']])(
    '%j is invalid',
    (raw) => {
      expect(parseBriefField(raw, ctx)).toBe('invalid');
    },
  );
});

describe('decodeBrief', () => {
  it('strips a BOM and keeps the rest verbatim', () => {
    expect(decodeBrief(enc(`${BOM}hello `))).toEqual({ ok: true, text: 'hello ' });
  });
  it('whitespace only is no brief', () => {
    expect(decodeBrief(enc('  \n'))).toEqual({ ok: true, text: null });
  });
  it('the byte cap is on the trimmed text', () => {
    const at = 'a'.repeat(BRIEF_MAX_BYTES);
    expect(decodeBrief(enc(` ${at} `))).toEqual({ ok: true, text: ` ${at} ` });
    expect(decodeBrief(enc('a'.repeat(BRIEF_MAX_BYTES + 1)))).toEqual({
      ok: false,
      error: 'brief-too-large',
    });
  });
  it('invalid UTF-8 is invalid', () => {
    expect(decodeBrief(Uint8Array.from([0xff]))).toEqual({ ok: false, error: 'brief-invalid' });
  });
  it('a NUL is invalid', () => {
    expect(decodeBrief(enc('a\0b'))).toEqual({ ok: false, error: 'brief-invalid' });
  });
  it('decodeBriefText applies the same rules', () => {
    for (const t of [`${BOM}hi `, '  ', 'a\0', 'é'.repeat(BRIEF_MAX_BYTES)]) {
      expect(decodeBriefText(t)).toEqual(decodeBrief(enc(t)));
    }
  });
});

describe('briefByteCount', () => {
  it('counts trimmed UTF-8 bytes', () => {
    expect(briefByteCount(' é ')).toBe(2);
  });
});

describe('briefArgs', () => {
  const p = { briefDir: '/u/briefs/k', briefFile: '/u/briefs/k/brief.md', sendPrompt: true };
  const prompt = 'Read your role brief at /u/briefs/k/brief.md and follow it.';
  it('the prompt text', () => {
    expect(briefPrompt(p.briefFile)).toBe(prompt);
  });
  it('add-dir support grants the dir, then the prompt after --', () => {
    expect(briefArgs({ readAccess: 'add-dir' }, p)).toEqual([
      '--add-dir',
      '/u/briefs/k',
      '--',
      prompt,
    ]);
  });
  it('no read access sends only the prompt', () => {
    expect(briefArgs({ readAccess: 'none' }, p)).toEqual(['--', prompt]);
  });
  it('an already-sent brief on a none launcher adds nothing', () => {
    expect(briefArgs({ readAccess: 'none' }, { ...p, sendPrompt: false })).toEqual([]);
  });
  it('an already-sent brief on add-dir keeps the read grant', () => {
    expect(briefArgs({ readAccess: 'add-dir' }, { ...p, sendPrompt: false })).toEqual([
      '--add-dir',
      '/u/briefs/k',
    ]);
  });
});

describe('briefPreviewArgs', () => {
  it('elides the id', () => {
    expect(briefPreviewArgs({ readAccess: 'add-dir' })).toEqual([
      '--add-dir',
      BRIEF_PREVIEW_DIR,
      '--',
      `Read your role brief at ${BRIEF_PREVIEW_DIR}/brief.md and follow it.`,
    ]);
    expect(BRIEF_PREVIEW_DIR).toBe('…/briefs/<id>');
  });
});

describe('planBriefSpawn', () => {
  const base = {
    state: 'pending' as const,
    support: { readAccess: 'add-dir' as const },
    canonicalExists: true,
    guarded: false,
    briefDir: '/u/briefs/k',
    briefFile: '/u/briefs/k/brief.md',
  };
  it('no state → none', () => {
    expect(planBriefSpawn({ ...base, state: undefined })).toEqual({ kind: 'none' });
  });
  it('no support → none, even when the canonical file is missing', () => {
    expect(planBriefSpawn({ ...base, support: null, canonicalExists: false })).toEqual({
      kind: 'none',
    });
  });
  it('missing canonical clears; the banner only for pending', () => {
    expect(planBriefSpawn({ ...base, canonicalExists: false })).toEqual({
      kind: 'clear',
      drop: { code: 'file-missing' },
      banner: true,
    });
    expect(planBriefSpawn({ ...base, state: 'sent', canonicalExists: false })).toEqual({
      kind: 'clear',
      drop: { code: 'file-missing' },
      banner: false,
    });
  });
  it('a guarded launcher with a metachar in the dir clears', () => {
    const r = planBriefSpawn({
      ...base,
      guarded: true,
      briefDir: '/u%/briefs/k',
      briefFile: '/u%/briefs/k/brief.md',
    });
    expect(r).toEqual({
      kind: 'clear',
      drop: { code: 'cmd-metachar', char: '%' },
      banner: true,
    });
    expect(
      planBriefSpawn({
        ...base,
        state: 'sent',
        guarded: true,
        briefDir: '/u%/briefs/k',
        briefFile: '/u%/briefs/k/brief.md',
      }),
    ).toMatchObject({ kind: 'clear', banner: false });
  });
  it('an unguarded launcher ignores metachars', () => {
    expect(planBriefSpawn({ ...base, briefDir: '/u%/b', briefFile: '/u%/b/brief.md' })).toEqual({
      kind: 'args',
      sendPrompt: true,
    });
  });
  it('args: the prompt goes only for pending', () => {
    expect(planBriefSpawn(base)).toEqual({ kind: 'args', sendPrompt: true });
    expect(planBriefSpawn({ ...base, state: 'sent' })).toEqual({ kind: 'args', sendPrompt: false });
  });
});

describe('briefBanner', () => {
  it('is a dim one-liner', () => {
    expect(briefBanner({ code: 'file-missing' })).toBe(
      '\r\n\x1b[2m— role brief not sent: file missing —\x1b[0m\r\n',
    );
  });
  it('names the metachar', () => {
    expect(briefBanner({ code: 'cmd-metachar', char: '%' })).toContain('path has "%"');
  });
  it.each([
    ['brief-unreadable', "can't read the file"],
    ['brief-too-large', 'over 64 KiB'],
    ['brief-invalid', 'not UTF-8 text'],
    ['brief-io', "couldn't save it"],
    ['rebuild-failed', "couldn't prepare it, will retry next launch"],
    ['copy-failed', "couldn't copy it from the original"],
  ] as const)('%s', (code, reason) => {
    expect(briefBanner({ code })).toContain(`role brief not sent: ${reason} —`);
  });
});
