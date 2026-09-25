import { spawn } from 'node:child_process';
import { OS_CLIPBOARD_TIMEOUT_MS } from '../src/drag-out-policy';
import type { OsClipboardPayload, PowerShellSpawn } from '../src/os-clipboard-payload';

export type OsClipboardWriteResult = { ok: true } | { ok: false; detail: string };
export interface OsFileClipboardDeps {
  runPowerShell(spec: PowerShellSpawn, timeoutMs: number): Promise<OsClipboardWriteResult>;
  writeBuffer(format: string, data: Buffer): void;
}
export interface OsFileClipboard {
  /** Serialised: a write starts only after the previous one settled. Only the newest waiting
   *  write is kept; one it replaces settles as {ok:false, detail:'superseded'} without running. */
  execute(
    p: Extract<OsClipboardPayload, { kind: 'powershell' | 'plist' }>,
  ): Promise<OsClipboardWriteResult>;
}

const failure = (err: unknown): OsClipboardWriteResult => ({
  ok: false,
  detail: err instanceof Error ? err.message : String(err),
});

type WritePayload = Extract<OsClipboardPayload, { kind: 'powershell' | 'plist' }>;

export function createOsFileClipboard(deps: OsFileClipboardDeps): OsFileClipboard {
  let running = false;
  let pending: { p: WritePayload; resolve: (r: OsClipboardWriteResult) => void } | null = null;
  const run = async (p: WritePayload): Promise<OsClipboardWriteResult> => {
    try {
      if (p.kind === 'powershell')
        return await deps.runPowerShell(p.spawn, OS_CLIPBOARD_TIMEOUT_MS);
      deps.writeBuffer(p.format, Buffer.from(p.xml, 'utf8'));
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  };
  const drain = async (p: WritePayload, resolve: (r: OsClipboardWriteResult) => void) => {
    running = true;
    resolve(await run(p));
    const next = pending;
    pending = null;
    if (next) void drain(next.p, next.resolve);
    else running = false;
  };
  return {
    execute(p) {
      return new Promise((resolve) => {
        if (!running) {
          void drain(p, resolve);
          return;
        }
        pending?.resolve({ ok: false, detail: 'superseded' });
        pending = { p, resolve };
      });
    },
  };
}

export function spawnPowerShell(
  spec: PowerShellSpawn,
  timeoutMs: number,
): Promise<OsClipboardWriteResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: OsClipboardWriteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(spec.file, spec.args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < 500) stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, detail: 'timeout' });
    }, timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) =>
      settle({ ok: false, detail: err.code ?? err.message }),
    );
    child.on('close', (code) =>
      settle(
        code === 0 ? { ok: true } : { ok: false, detail: stderr.slice(0, 500) || `exit ${code}` },
      ),
    );
    // A child that dies before reading stdin raises EPIPE here; 'close' reports the real outcome.
    child.stdin?.on('error', () => {});
    child.stdin?.end(spec.stdin);
  });
}
