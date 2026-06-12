import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conduitDir, conduitPath, proposalPath } from '../../electron/conduit-fs';
import { ProposalWatcher } from '../../electron/proposal-watcher';
import { serializeBoardArtifact } from '../../src/conduit-store';
import { board, delay, expectNoEventAfterWrite, waitFor } from './watch-test-helpers';

let root: string;
let watcher: ProposalWatcher;

/** Create an empty `.conduit/` dir then start watching, collecting proposal kinds. */
function mkdirAndWatch(): string[] {
  fs.mkdirSync(conduitDir(root), { recursive: true });
  const seen: string[] = [];
  watcher.watch(root, (kind) => seen.push(kind));
  return seen;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-propwatch-'));
  watcher = new ProposalWatcher(40);
});

afterEach(() => {
  watcher.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ProposalWatcher', () => {
  it('fires when a board proposal appears', async () => {
    const seen = mkdirAndWatch();

    fs.writeFileSync(
      proposalPath(root, 'board'),
      serializeBoardArtifact(board([{ id: 'p', title: 'P', notes: '', stage: 'planning' }])),
    );

    await waitFor(() => seen.includes('board'));
    expect(seen).toContain('board');
  });

  it('fires when a board proposal is deleted (so the banner clears live)', async () => {
    fs.mkdirSync(conduitDir(root), { recursive: true });
    fs.writeFileSync(
      proposalPath(root, 'board'),
      serializeBoardArtifact(board([{ id: 'p', title: 'P', notes: '', stage: 'planning' }])),
    );
    const seen: string[] = [];
    watcher.watch(root, (kind) => seen.push(kind));

    fs.rmSync(proposalPath(root, 'board'));
    await waitFor(() => seen.includes('board'));
    expect(seen).toContain('board');
  });

  it('ignores edits to the canonical board.json (not a proposal)', async () => {
    const seen = mkdirAndWatch();

    fs.writeFileSync(
      conduitPath(root, 'board.json'),
      serializeBoardArtifact(board([{ id: 'a', title: 'A', notes: '', stage: 'done' }])),
    );
    await delay(250);
    expect(seen).toEqual([]);
  });

  it('stops watching after stop()', async () => {
    const seen = mkdirAndWatch();
    watcher.stop();

    await expectNoEventAfterWrite(
      proposalPath(root, 'board'),
      [{ id: 'p', title: 'P', notes: '', stage: 'planning' }],
      seen,
    );
  });

  it('is a no-op for a falsy root', () => {
    expect(() => watcher.watch('', () => {})).not.toThrow();
  });
});
