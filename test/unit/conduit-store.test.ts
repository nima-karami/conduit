import { describe, expect, it } from 'vitest';
import { type ArchDoc, seedArchitecture } from '../../src/architecture';
import { type BoardData, seedBoard } from '../../src/board';
import {
  CONDUIT_VERSION,
  emptyBoardData,
  readArchitectureArtifact,
  readBoardArtifact,
  serializeArchitectureArtifact,
  serializeBoardArtifact,
} from '../../src/conduit-store';

describe('conduit-store envelope', () => {
  it('serializes an architecture envelope with conduit version, kind, updatedAt, and data', () => {
    const doc = seedArchitecture('Demo');
    const json = serializeArchitectureArtifact(doc, 1000);
    const parsed = JSON.parse(json);
    expect(parsed.conduit).toBe(CONDUIT_VERSION);
    expect(parsed.kind).toBe('architecture');
    expect(parsed.updatedAt).toBe(1000);
    expect(parsed.data.rootGraph).toBe(doc.rootGraph);
    // payload self-versions; no mirrored `schema` field on the envelope
    expect(parsed.data.version).toBe(1);
    expect(parsed.schema).toBeUndefined();
  });

  it('serializes a board envelope with conduit version, kind, updatedAt, and data', () => {
    const board = seedBoard();
    const json = serializeBoardArtifact(board, 2000);
    const parsed = JSON.parse(json);
    expect(parsed.conduit).toBe(CONDUIT_VERSION);
    expect(parsed.kind).toBe('board');
    expect(parsed.updatedAt).toBe(2000);
    expect(parsed.data.cards).toHaveLength(board.cards.length);
    expect(parsed.schema).toBeUndefined();
  });

  it('round-trips an architecture doc through the envelope (ids, kinds, positions, prose preserved)', () => {
    const doc = seedArchitecture('Round-Trip');
    const restored = readArchitectureArtifact(serializeArchitectureArtifact(doc));
    expect(restored).toEqual(doc);
  });

  it('round-trips a board through the envelope (ids, stages, notes, timestamps preserved)', () => {
    const board: BoardData = {
      version: 1,
      cards: [
        {
          id: 'card-abc',
          title: 'Go-to-definition',
          notes: 'needs TS worker',
          stage: 'wishlist',
          links: ['https://example.com/42'],
          createdAt: 100,
          updatedAt: 200,
        },
      ],
    };
    const restored = readBoardArtifact(serializeBoardArtifact(board));
    expect(restored).toEqual(board);
  });
});

describe('conduit-store defaults & back-compat', () => {
  it('architecture: absent/invalid blob returns null (caller seeds)', () => {
    expect(readArchitectureArtifact(undefined)).toBeNull();
    expect(readArchitectureArtifact('not json')).toBeNull();
    expect(readArchitectureArtifact('{}')).toBeNull();
  });

  it('board: absent/invalid blob returns an EMPTY board, never seedBoard()', () => {
    const fromAbsent = readBoardArtifact(undefined);
    expect(fromAbsent).toEqual(emptyBoardData());
    expect(fromAbsent.cards).toEqual([]);
    // critical: must NOT inject Conduit's own seed backlog into a foreign project
    expect(fromAbsent.cards.find((c) => c.id === 'seed-f1')).toBeUndefined();
    expect(readBoardArtifact('not json').cards).toEqual([]);
  });

  it('tolerates a bare (un-enveloped) architecture payload', () => {
    const doc = seedArchitecture('Bare');
    // simulate today's bare architecture.json: the raw ArchDoc, no conduit wrapper
    const bareBlob = JSON.stringify(doc);
    const restored = readArchitectureArtifact(bareBlob);
    expect(restored).toEqual(doc);
  });

  it('tolerates a bare (un-enveloped) board payload', () => {
    const board: BoardData = {
      version: 1,
      cards: [{ id: 'x', title: 'T', notes: '', stage: 'done' }],
    };
    const bareBlob = JSON.stringify(board);
    const restored = readBoardArtifact(bareBlob);
    expect(restored.cards.map((c) => c.id)).toEqual(['x']);
  });

  it('ignores an unknown envelope version but still reads the data payload', () => {
    const doc = seedArchitecture('Future');
    const futureEnvelope = JSON.stringify({
      conduit: 999,
      kind: 'architecture',
      updatedAt: 1,
      data: doc,
    });
    // degrade gracefully: read the payload rather than throwing
    const restored = readArchitectureArtifact(futureEnvelope);
    expect(restored).toEqual(doc);
  });

  it('reads the board payload out of an envelope even with a mismatched kind field', () => {
    const board = seedBoard();
    const envelope = JSON.stringify({ conduit: 1, kind: 'whatever', updatedAt: 1, data: board });
    const restored = readBoardArtifact(envelope);
    expect(restored.cards).toHaveLength(board.cards.length);
  });

  it('applies domain migrations through the envelope (legacy arch kind mapped forward)', () => {
    // legacy kind `ui` should migrate to `frontend` via the domain restore path
    const legacy: ArchDoc = {
      version: 1,
      rootGraph: 'g',
      graphs: {
        g: {
          id: 'g',
          title: 'G',
          // biome-ignore lint/suspicious/noExplicitAny: deliberately a legacy kind string
          nodes: [{ id: 'n1', title: 'N', kind: 'ui' as any, x: 0, y: 0 }],
          edges: [],
        },
      },
    };
    const restored = readArchitectureArtifact(serializeArchitectureArtifact(legacy));
    expect(restored?.graphs.g.nodes[0].kind).toBe('frontend');
  });
});
