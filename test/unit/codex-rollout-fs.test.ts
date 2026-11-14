import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRolloutFs } from '../../server/domain/codex-rollout-fs';
import { tempRoots } from '../helpers/temp-roots';

const roots = tempRoots('rollout-fs-');

describe('createRolloutFs', () => {
  it('readFrom returns whole lines only and resumes at the first unread byte', async () => {
    const file = join(roots.root(), 'r.jsonl');
    writeFileSync(file, 'one\ntwo\npart');
    const fs = createRolloutFs({ onFirstLineTooLong: () => {} });
    const a = await fs.readFrom(file, 0);
    expect(a).toEqual({ data: 'one\ntwo\n', size: 8 });
    appendFileSync(file, 'ial\n');
    expect(await fs.readFrom(file, a.size)).toEqual({ data: 'partial\n', size: 16 });
    expect(await fs.readFrom(file, 16)).toEqual({ data: '', size: 16 });
  });

  it('never splits a multi-byte character across reads', async () => {
    const file = join(roots.root(), 'r.jsonl');
    const line = 'caf\u00e9 \u{1F600}';
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    writeFileSync(file, bytes.subarray(0, bytes.length - 3));
    const fs = createRolloutFs({ onFirstLineTooLong: () => {} });
    const a = await fs.readFrom(file, 0);
    expect(a).toEqual({ data: '', size: 0 });
    writeFileSync(file, bytes);
    expect(await fs.readFrom(file, a.size)).toEqual({ data: `${line}\n`, size: bytes.length });
  });

  it('a truncated file moves the offset back instead of past the end', async () => {
    const file = join(roots.root(), 'r.jsonl');
    writeFileSync(file, 'a\n');
    const fs = createRolloutFs({ onFirstLineTooLong: () => {} });
    expect(await fs.readFrom(file, 50)).toEqual({ data: '', size: 2 });
  });

  it('readFirstLine reads past one chunk and reports a line over the cap once per call', async () => {
    const dir = roots.root();
    const long = join(dir, 'long.jsonl');
    writeFileSync(long, `${'x'.repeat(100_000)}\nrest\n`);
    const tooLong: string[] = [];
    const fs = createRolloutFs({ onFirstLineTooLong: (f) => tooLong.push(f) });
    expect((await fs.readFirstLine(long))?.length).toBe(100_000);
    const capped = createRolloutFs({
      onFirstLineTooLong: (f) => tooLong.push(f),
      firstLineMaxBytes: 1000,
    });
    expect(await capped.readFirstLine(long)).toBeNull();
    expect(tooLong).toEqual([long]);
    const torn = join(dir, 'torn.jsonl');
    writeFileSync(torn, '{"type":"session_meta"');
    expect(await fs.readFirstLine(torn)).toBeNull();
  });
});
