import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPipelineQueueEntry,
  conduitDir,
  conduitPath,
  readArchitectureArtifactFile,
  readArchitectureForProject,
  readBoardArtifactFile,
  readBoardForProject,
  readPipelineForProject,
  writeArchitectureArtifactFile,
  writeBoardArtifactFile,
  writePipelineArtifactFile,
} from '../../electron/conduit-fs';
import { seedArchitecture, serializeArchitecture } from '../../src/architecture';
import type { BoardData } from '../../src/board';
import { readPipelineQueueArtifact } from '../../src/conduit-store';
import { buildQueueEntry, emptyPipelineConfig, setTransitionSkill } from '../../src/pipeline';

let root: string;

/** Assert the atomic writers left no `*.tmp` files behind in `.conduit/`. */
function expectNoTempLeftovers() {
  const leftovers = fs.readdirSync(conduitDir(root)).filter((f) => f.endsWith('.tmp'));
  expect(leftovers).toEqual([]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-fs-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('conduit-fs resolution', () => {
  it('resolves .conduit/ at the project root, not the install dir', () => {
    expect(conduitDir(root)).toBe(path.join(root, '.conduit'));
    expect(conduitPath(root, 'specs', 'card-1.md')).toBe(
      path.join(root, '.conduit', 'specs', 'card-1.md'),
    );
  });
});

describe('conduit-fs read defaults (no .conduit/ yet)', () => {
  it('architecture: absent file returns null', () => {
    expect(readArchitectureArtifactFile(root)).toBeNull();
  });

  it('board: absent file returns an empty board (never Conduit seed)', () => {
    const board = readBoardArtifactFile(root);
    expect(board.cards).toEqual([]);
    expect(board.cards.find((c) => c.id === 'seed-f1')).toBeUndefined();
  });
});

describe('conduit-fs write → read round-trip in a temp dir', () => {
  it('creates .conduit/ on write and round-trips an architecture doc', async () => {
    const doc = seedArchitecture('Temp Project');
    expect(fs.existsSync(conduitDir(root))).toBe(false);

    await writeArchitectureArtifactFile(root, doc);

    expect(fs.existsSync(conduitDir(root))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(conduitPath(root, 'architecture.json'), 'utf8'));
    expect(onDisk.kind).toBe('architecture');
    expect(onDisk.conduit).toBe(1);

    expect(readArchitectureArtifactFile(root)).toEqual(doc);
  });

  it('round-trips a board doc through .conduit/board.json', async () => {
    const board: BoardData = {
      version: 1,
      cards: [
        { id: 'c1', title: 'Feature', notes: 'n', stage: 'planning', createdAt: 1, updatedAt: 2 },
      ],
    };
    await writeBoardArtifactFile(root, board);
    expect(readBoardArtifactFile(root)).toEqual(board);
  });

  it('leaves no temp files behind after an atomic write', async () => {
    await writeArchitectureArtifactFile(root, seedArchitecture('X'));
    expectNoTempLeftovers();
  });

  it('surfaces write errors instead of swallowing them', async () => {
    // Point the project root at a regular FILE, so mkdir of `<file>/.conduit` fails.
    const filePath = path.join(root, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    await expect(writeBoardArtifactFile(filePath, { version: 1, cards: [] })).rejects.toThrow();
  });
});

describe('readBoardForProject (per-project board read)', () => {
  it('returns an empty board for a falsy root rather than reading the cwd', () => {
    expect(readBoardForProject('')).toEqual({ version: 1, cards: [] });
  });

  it('returns an empty board when .conduit/board.json is absent (no Conduit seed)', () => {
    const board = readBoardForProject(root);
    expect(board.cards).toEqual([]);
    expect(board.cards.find((c) => c.id === 'seed-f1')).toBeUndefined();
  });

  it('reads .conduit/board.json when present', async () => {
    const board: BoardData = {
      version: 1,
      cards: [{ id: 'c1', title: 'Feature', notes: 'n', stage: 'building' }],
    };
    await writeBoardArtifactFile(root, board);
    expect(readBoardForProject(root).cards.map((c) => c.id)).toEqual(['c1']);
  });
});

describe('readArchitectureForProject (read + legacy migration)', () => {
  it('returns null when neither .conduit/ nor the legacy file exists', () => {
    expect(readArchitectureForProject(root)).toBeNull();
  });

  it('reads .conduit/architecture.json when present', async () => {
    const doc = seedArchitecture('Conduit Home');
    await writeArchitectureArtifactFile(root, doc);
    expect(readArchitectureForProject(root)).toEqual(doc);
  });

  it('migrates the legacy bare <root>/architecture.json when .conduit/ is absent', () => {
    const doc = seedArchitecture('Legacy');
    fs.writeFileSync(path.join(root, 'architecture.json'), serializeArchitecture(doc));
    expect(fs.existsSync(conduitDir(root))).toBe(false);

    const loaded = readArchitectureForProject(root);
    expect(loaded).toEqual(doc);

    // LLM-readable prose survives the legacy read: the seed carries edge labels +
    // node subtitles, which are the natural-language layer an agent reasons over.
    const g = loaded?.graphs[loaded.rootGraph];
    expect(g?.edges.some((e) => e.label === 'IPC')).toBe(true);
    expect(g?.nodes.some((n) => n.subtitle === 'React webview')).toBe(true);
  });

  it('prefers .conduit/ over the legacy file when both exist', async () => {
    const legacy = seedArchitecture('Legacy');
    fs.writeFileSync(path.join(root, 'architecture.json'), serializeArchitecture(legacy));
    const canonical = seedArchitecture('Canonical');
    await writeArchitectureArtifactFile(root, canonical);

    const loaded = readArchitectureForProject(root);
    expect(loaded?.graphs[canonical.rootGraph]?.title).toBe('Canonical');
  });

  it('falls back to legacy when .conduit/architecture.json is corrupt', () => {
    fs.mkdirSync(conduitDir(root), { recursive: true });
    fs.writeFileSync(conduitPath(root, 'architecture.json'), '{ not json');
    const legacy = seedArchitecture('Legacy');
    fs.writeFileSync(path.join(root, 'architecture.json'), serializeArchitecture(legacy));

    expect(readArchitectureForProject(root)).toEqual(legacy);
  });

  it('returns null for a falsy root rather than reading the cwd', () => {
    expect(readArchitectureForProject('')).toBeNull();
  });
});

describe('pipeline config + queue (G4)', () => {
  it('returns an empty config for a falsy root or an absent file', () => {
    expect(readPipelineForProject('')).toEqual(emptyPipelineConfig());
    expect(readPipelineForProject(root)).toEqual(emptyPipelineConfig());
  });

  it('round-trips a pipeline config through .conduit/pipeline.json', async () => {
    const config = setTransitionSkill(
      emptyPipelineConfig(),
      'planning',
      'building',
      'writing-plans',
    );
    await writePipelineArtifactFile(root, config);

    const onDisk = JSON.parse(fs.readFileSync(conduitPath(root, 'pipeline.json'), 'utf8'));
    expect(onDisk.kind).toBe('pipeline');
    expect(onDisk.conduit).toBe(1);

    expect(readPipelineForProject(root)).toEqual(config);
  });

  it('surfaces a failed pipeline write instead of swallowing it', async () => {
    const filePath = path.join(root, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    await expect(writePipelineArtifactFile(filePath, emptyPipelineConfig())).rejects.toThrow();
  });

  it('appends transition entries to .conduit/pipeline-queue.json (creates then grows)', async () => {
    const e1 = buildQueueEntry(
      { id: 'c1', title: 'A' },
      'wishlist',
      'planning',
      'feature-spec',
      1,
      'q1',
    );
    const e2 = buildQueueEntry(
      { id: 'c2', title: 'B' },
      'planning',
      'building',
      'writing-plans',
      2,
      'q2',
    );

    await appendPipelineQueueEntry(root, e1);
    await appendPipelineQueueEntry(root, e2);

    const onDisk = JSON.parse(fs.readFileSync(conduitPath(root, 'pipeline-queue.json'), 'utf8'));
    expect(onDisk.kind).toBe('pipeline-queue');
    const queue = readPipelineQueueArtifact(JSON.stringify(onDisk));
    expect(queue.entries.map((e) => e.id)).toEqual(['q1', 'q2']);
    expect(queue.entries[1]).toMatchObject({
      cardId: 'c2',
      transition: 'planning->building',
      skill: 'writing-plans',
    });
  });

  it('leaves no temp files behind after a queue append', async () => {
    await appendPipelineQueueEntry(
      root,
      buildQueueEntry({ id: 'c', title: 'T' }, 'building', 'done', 'verify', 1, 'q'),
    );
    expectNoTempLeftovers();
  });

  it('serializes concurrent appends so none is lost (read-modify-write race guard)', async () => {
    // Fire many appends WITHOUT awaiting between them — the per-root chain must serialize
    // them so each read sees the prior write, instead of interleaving and dropping entries.
    const entries = Array.from({ length: 20 }, (_, i) =>
      buildQueueEntry(
        { id: `c${i}`, title: `T${i}` },
        'wishlist',
        'planning',
        'feature-spec',
        i,
        `q${i}`,
      ),
    );
    await Promise.all(entries.map((e) => appendPipelineQueueEntry(root, e)));

    const queue = readPipelineQueueArtifact(
      fs.readFileSync(conduitPath(root, 'pipeline-queue.json'), 'utf8'),
    );
    expect(queue.entries).toHaveLength(20);
    expect(new Set(queue.entries.map((e) => e.id)).size).toBe(20);
  });
});
