import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeIdentityAdapter } from '../../src/agent-identity/claude';
import { readTitles } from '../../src/agent-identity/claude-transcript';
import type {
  AgentIdentityLaunch,
  ConversationReference,
} from '../../src/contracts/agent-identity';
import type { LaunchIds } from '../../src/contracts/terminal-runtime';

const ID = '023ee6d4-6409-45b0-88dc-48ec9819fc77';
const OTHER = '023ee6d4-6409-45b0-88dc-48ec9819fc78';
const title = (customTitle: string, sessionId = ID) =>
  JSON.stringify({ type: 'custom-title', customTitle, sessionId });

function setup() {
  const controller = new AbortController();
  const ids = { generation: 2, launchId: 'c'.repeat(32) };
  const cwd = path.resolve('project');
  const storageHome = path.join(cwd, 'custom-config');
  const scope = { cwd, storageHome, machineId: 'local' };
  const launch: AgentIdentityLaunch = {
    sessionId: 'conduit-id',
    ids,
    scope,
    command: 'claude',
    argv: [
      '--permission-mode',
      'plan',
      '--mcp-config',
      'one.json',
      'two.json',
      '--add-dir',
      'docs',
    ],
    env: { CLAUDE_CONFIG_DIR: 'custom-config' },
    signal: controller.signal,
  };
  const ref: ConversationReference = {
    version: 1,
    adapterId: 'claude',
    scope,
    capturedAt: { generation: 1, launchId: 'b'.repeat(32) },
    conversationId: ID,
  };
  const fileFor = (id: string) => path.join(storageHome, 'projects', 'encoding', `${id}.jsonl`);
  const file = fileFor(ID);
  let lines = [title('Historical')];
  let inode = 1n;
  let receiver: (ids: LaunchIds, payload: unknown) => void = () => undefined;
  const unsubscribe = vi.fn();
  const fs = {
    checkTranscript: vi.fn(async (_root: string, candidate: string, _id: string) => candidate),
    findTranscript: vi.fn(async (): Promise<string | undefined> => file),
    appendTitle: vi.fn(async (_file: string, record: object) => {
      lines.push(JSON.stringify(record));
    }),
    readTitles: vi.fn(async (_file: string, cursor: unknown, onLine: (line: string) => void) => {
      for (const line of lines) onLine(line);
      lines = [];
      return {
        inode,
        device: 1n,
        offset: cursor ? 1 : 0,
        fragment: Buffer.alloc(0),
      };
    }),
  };
  const adapter = createClaudeIdentityAdapter({
    subscribeSessionStart(_launch, receive) {
      receiver = receive;
      return unsubscribe;
    },
    fs,
  });
  const observer = { bind: vi.fn(), rename: vi.fn(), unbind: vi.fn() };
  return {
    adapter,
    controller,
    ref,
    launch,
    observer,
    fs,
    unsubscribe,
    hook: (id = ID, launchIds = ids, source = 'resume') =>
      receiver(launchIds, { session_id: id, transcript_path: fileFor(id), source }),
    push: (...newLines: string[]) => lines.push(...newLines),
    replace: (...newLines: string[]) => {
      inode += 1n;
      lines = newLines;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('Claude identity argv and SessionStart', () => {
  it('preserves native and MCP arguments when prefixing fresh and exact resume flags', async () => {
    const { adapter, launch, ref } = setup();
    const fresh = await adapter.fresh(launch, 'Fresh');
    expect(fresh.argv[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.argv).toEqual(['--session-id', fresh.argv[1], '--name', 'Fresh', ...launch.argv]);
    const next = await adapter.fresh(launch, 'Fresh');
    expect(next.argv[1]).not.toBe(fresh.argv[1]);
    expect(await adapter.resume(launch, ref, 'Current')).toEqual({
      argv: ['--resume', ID, '--name', 'Current', ...launch.argv],
    });
  });

  it('binds only the expected session ID, source and launch IDs', async () => {
    vi.useFakeTimers();
    const { adapter, launch, ref, hook, observer, fs, controller, unsubscribe } = setup();
    await adapter.resume(launch, ref, 'Current');
    await adapter.observe(launch, observer);
    hook(ID, ref.capturedAt);
    hook(ID, { ...launch.ids, generation: 8 });
    hook(ID, { ...launch.ids, launchId: 'a'.repeat(32) });
    hook(OTHER);
    hook(ID, launch.ids, 'startup');
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.bind).not.toHaveBeenCalled();
    hook();
    hook();
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.bind).toHaveBeenCalledExactlyOnceWith(ID);
    expect(fs.checkTranscript.mock.calls[0]).toEqual([
      path.join(launch.scope.storageHome, 'projects'),
      expect.any(String),
      ID,
    ]);
    controller.abort();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const reads = fs.readTitles.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fs.readTitles).toHaveBeenCalledTimes(reads);
  });

  it('rebinds on clear, cancels the old watcher, and ignores compact and foreign launches', async () => {
    vi.useFakeTimers();
    const { adapter, launch, ref, hook, observer, fs, push, controller } = setup();
    await adapter.resume(launch, ref, 'Current');
    await adapter.observe(launch, observer);
    hook();
    await vi.advanceTimersByTimeAsync(0);

    let finishOldRead: () => void = () => undefined;
    fs.readTitles.mockImplementationOnce(async (_file, _cursor, onLine) => {
      await new Promise<void>((resolve) => {
        finishOldRead = resolve;
      });
      onLine(title('Stale title'));
      return { inode: 1n, device: 1n, offset: 1, fragment: Buffer.alloc(0) };
    });
    await vi.advanceTimersByTimeAsync(250);
    hook(OTHER, ref.capturedAt, 'clear');
    hook(ID, launch.ids, 'compact');
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.bind.mock.calls).toEqual([[ID]]);

    hook(OTHER, launch.ids, 'clear');
    await vi.advanceTimersByTimeAsync(0);
    finishOldRead();
    push(title('After clear', OTHER));
    await vi.advanceTimersByTimeAsync(250);
    expect(observer.bind.mock.calls).toEqual([[ID], [OTHER]]);
    expect(observer.rename.mock.calls).toEqual([
      [{ name: 'After clear', conversationId: OTHER, source: 'native' }],
    ]);
    expect(observer.unbind).not.toHaveBeenCalled();
    const watched = fs.readTitles.mock.calls.slice(-2).map(([file]) => path.basename(file));
    expect(watched).toEqual([`${OTHER}.jsonl`, `${OTHER}.jsonl`]);
    controller.abort();
  });

  it('rebinds on resume and reports only the selected conversation’s latest saved title', async () => {
    vi.useFakeTimers();
    const { adapter, launch, ref, hook, observer, push, controller } = setup();
    await adapter.resume(launch, ref, 'Current');
    await adapter.observe(launch, observer);
    hook();
    await vi.advanceTimersByTimeAsync(0);

    push(title('Old saved title', OTHER), title('Current saved title', OTHER));
    hook(OTHER, launch.ids, 'resume');
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.bind.mock.calls).toEqual([[ID], [OTHER]]);
    expect(observer.rename).toHaveBeenCalledExactlyOnceWith({
      name: 'Current saved title',
      conversationId: OTHER,
      source: 'native',
    });
    controller.abort();
  });

  it('dedupes titles and correlates echoed writes by record marker', async () => {
    vi.useFakeTimers();
    const { adapter, launch, ref, hook, observer, push, controller } = setup();
    await adapter.resume(launch, ref, 'Current');
    await adapter.observe(launch, observer);
    hook();
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.rename).not.toHaveBeenCalled();
    push(title('Wrong', OTHER), title('Native'), title('Native'));
    await vi.advanceTimersByTimeAsync(250);
    expect(observer.rename).toHaveBeenCalledExactlyOnceWith({
      name: 'Native',
      conversationId: ID,
      source: 'native',
    });
    push(title('Same text'));
    await adapter.setName(ref, 'Same text', 4);
    await vi.advanceTimersByTimeAsync(250);
    expect(observer.rename.mock.calls.slice(1)).toEqual([
      [{ name: 'Same text', conversationId: ID, source: 'native' }],
      [
        {
          name: 'Same text',
          conversationId: ID,
          source: 'native',
          echoRevision: 4,
        },
      ],
    ]);
    controller.abort();
  });

  it('observes a rename between observation and the hook and skips copied history on rotation', async () => {
    vi.useFakeTimers();
    const { adapter, launch, ref, hook, observer, push, replace, controller } = setup();
    await adapter.resume(launch, ref, 'Current');
    await adapter.observe(launch, observer);
    push(title('Early rename'));
    hook();
    await vi.advanceTimersByTimeAsync(0);
    replace(title('Historical'), title('Early rename'), title('After rotation'));
    await vi.advanceTimersByTimeAsync(250);
    expect(observer.rename.mock.calls.map(([event]) => event.name)).toEqual([
      'Early rename',
      'After rotation',
    ]);
    controller.abort();
  });

  it('classifies positive, missing and unavailable transcript lookup', async () => {
    const { adapter, ref, fs } = setup();
    expect(await adapter.exists(ref)).toBe('present');
    fs.findTranscript.mockResolvedValueOnce(undefined);
    expect(await adapter.exists(ref)).toBe('missing');
    fs.findTranscript.mockRejectedValueOnce(Object.assign(new Error(), { code: 'EACCES' }));
    expect(await adapter.exists(ref)).toBe('unavailable');
  });
});

describe('Claude transcript I/O', () => {
  it('reads complete UTF-8 lines across polls and resets after replacement', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'claude-transcript-'));
    try {
      const file = path.join(temp, 'transcript.jsonl');
      const bytes = Buffer.from(title('名'));
      const split = bytes.indexOf(Buffer.from('名')) + 1;
      const lines: string[] = [];
      const onLine = (line: string) => lines.push(line);
      await writeFile(file, bytes.subarray(0, split));
      let cursor = await readTitles(file, undefined, onLine);
      expect(lines).toEqual([]);
      await appendFile(file, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]));
      cursor = await readTitles(file, cursor, onLine);
      expect(lines).toEqual([title('名')]);
      const replacement = path.join(temp, 'replacement.jsonl');
      await writeFile(replacement, `${title('replacement longer than old')}\n`);
      await rename(replacement, file);
      cursor = await readTitles(file, cursor, onLine);
      expect(lines).toEqual([title('名'), title('replacement longer than old')]);
      await writeFile(file, `${title('in-place overwrite of equal or longer length')}\n`);
      cursor = await readTitles(file, cursor, onLine);
      expect(cursor.restarted).toBe(true);
      expect(lines.at(-1)).toEqual(title('in-place overwrite of equal or longer length'));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('locates only a matching transcript within the selected config directory and appends a title', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'claude-config-'));
    try {
      const { ref } = setup();
      ref.scope.storageHome = temp;
      const adapter = createClaudeIdentityAdapter({
        subscribeSessionStart: () => () => undefined,
      });
      expect(await adapter.exists(ref)).toBe('missing');
      const project = path.join(temp, 'projects', 'encoded-project');
      await mkdir(project, { recursive: true });
      const file = path.join(project, `${ID}.jsonl`);
      await writeFile(file, `${title('First')}\n`);
      expect(await adapter.exists(ref)).toBe('present');
      await adapter.setName(ref, 'Second', 2);
      const record = JSON.parse((await readFile(file, 'utf8')).trim().split('\n').at(-1) ?? '');
      expect(record).toMatchObject(JSON.parse(title('Second')));
      await appendFile(file, title('Partial'));
      const partial = await readFile(file, 'utf8');
      await expect(adapter.setName(ref, 'Third', 3)).rejects.toThrow('incomplete record');
      expect(await readFile(file, 'utf8')).toBe(partial);
      expect(await adapter.exists({ ...ref, conversationId: '../escape' })).toBe('unavailable');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
