import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal,
  conduitPath,
  hasProposal,
  proposalPath,
  readArchitectureArtifactFile,
  readArchitectureProposal,
  readBoardArtifactFile,
  readBoardProposal,
  rejectProposal,
  writeArchitectureArtifactFile,
  writeBoardArtifactFile,
} from '../../electron/conduit-fs';
import { seedArchitecture } from '../../src/architecture';
import type { BoardData } from '../../src/board';
import { serializeArchitectureArtifact, serializeBoardArtifact } from '../../src/conduit-store';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-prop-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const board = (cards: BoardData['cards']): BoardData => ({ version: 1, cards });

function writeProposal(kind: 'board' | 'architecture', blob: string) {
  fs.mkdirSync(path.dirname(proposalPath(root, kind)), { recursive: true });
  fs.writeFileSync(proposalPath(root, kind), blob);
}

describe('proposal paths', () => {
  it('names the sibling *.proposed.json correctly', () => {
    expect(proposalPath(root, 'board')).toBe(conduitPath(root, 'board.proposed.json'));
    expect(proposalPath(root, 'architecture')).toBe(
      conduitPath(root, 'architecture.proposed.json'),
    );
  });
});

describe('reading proposals', () => {
  it('returns null when no proposal exists', () => {
    expect(readBoardProposal(root)).toBeNull();
    expect(readArchitectureProposal(root)).toBeNull();
    expect(hasProposal(root, 'board')).toBe(false);
  });

  it('reads a board proposal envelope into a validated payload', () => {
    writeProposal(
      'board',
      serializeBoardArtifact(board([{ id: 'p', title: 'Proposed', notes: '', stage: 'planning' }])),
    );
    expect(hasProposal(root, 'board')).toBe(true);
    const data = readBoardProposal(root);
    expect(data?.cards.map((c) => c.id)).toEqual(['p']);
  });

  it('reads an architecture proposal envelope', () => {
    writeProposal('architecture', serializeArchitectureArtifact(seedArchitecture('Proposed')));
    const data = readArchitectureProposal(root);
    expect(data?.graphs[data.rootGraph].title).toBe('Proposed');
  });
});

describe('acceptProposal', () => {
  it('applies the proposed board to the canonical file and deletes the proposal', async () => {
    await writeBoardArtifactFile(
      root,
      board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]),
    );
    writeProposal(
      'board',
      serializeBoardArtifact(board([{ id: 'a', title: 'A', notes: '', stage: 'done' }])),
    );

    await acceptProposal(root, 'board');

    expect(readBoardArtifactFile(root).cards[0].stage).toBe('done');
    expect(fs.existsSync(proposalPath(root, 'board'))).toBe(false);
  });

  it('applies the proposed architecture whole-document (id-stable) and deletes the proposal', async () => {
    await writeArchitectureArtifactFile(root, seedArchitecture('Old'));
    writeProposal('architecture', serializeArchitectureArtifact(seedArchitecture('New')));

    await acceptProposal(root, 'architecture');

    const doc = readArchitectureArtifactFile(root);
    expect(doc?.graphs[doc.rootGraph].title).toBe('New');
    expect(fs.existsSync(proposalPath(root, 'architecture'))).toBe(false);
  });

  it('rejects (throws) and leaves the canonical file untouched when there is no proposal', async () => {
    await writeBoardArtifactFile(
      root,
      board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]),
    );
    await expect(acceptProposal(root, 'board')).rejects.toThrow();
    expect(readBoardArtifactFile(root).cards[0].stage).toBe('wishlist');
  });
});

describe('rejectProposal', () => {
  it('deletes the proposal without touching the canonical file', async () => {
    await writeBoardArtifactFile(
      root,
      board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]),
    );
    writeProposal(
      'board',
      serializeBoardArtifact(board([{ id: 'a', title: 'A', notes: '', stage: 'done' }])),
    );

    await rejectProposal(root, 'board');

    expect(readBoardArtifactFile(root).cards[0].stage).toBe('wishlist');
    expect(fs.existsSync(proposalPath(root, 'board'))).toBe(false);
  });

  it('is a no-op (does not throw) when there is no proposal to reject', async () => {
    await expect(rejectProposal(root, 'board')).resolves.toBeUndefined();
  });
});
