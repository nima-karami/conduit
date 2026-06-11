import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conduitDir,
  conduitPath,
  readArchitectureArtifactFile,
  readArchitectureForProject,
  readBoardArtifactFile,
  writeArchitectureArtifactFile,
  writeBoardArtifactFile,
} from '../../electron/conduit-fs';
import { seedArchitecture, serializeArchitecture } from '../../src/architecture';
import type { BoardData } from '../../src/board';

let root: string;

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

    // dir created, file is a conduit envelope on disk
    expect(fs.existsSync(conduitDir(root))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(conduitPath(root, 'architecture.json'), 'utf8'));
    expect(onDisk.kind).toBe('architecture');
    expect(onDisk.conduit).toBe(1);

    // round-trips through the file reader
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
    const leftovers = fs.readdirSync(conduitDir(root)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('surfaces write errors instead of swallowing them', async () => {
    // Point the project root at a regular FILE, so mkdir of `<file>/.conduit` fails.
    const filePath = path.join(root, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    await expect(writeBoardArtifactFile(filePath, { version: 1, cards: [] })).rejects.toThrow();
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
