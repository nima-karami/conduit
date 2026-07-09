// One bounded, cancellable git runner. Every git spawn in the app routes through here so timeouts,
// output caps, and cancellation are uniform. See docs/specs/2026-07-07-git-host-robustness.md.
import { execFile } from 'node:child_process';

// Default per-call deadlines by operation weight (ms). Callers pass one of these or their own.
export const GIT_TIMEOUT = { metadata: 2000, diff: 10000, history: 5000, blame: 10000 } as const;

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitResult {
  ok: boolean; // true iff the process exited 0 within all limits
  stdout: string; // utf8 decode of stdoutBuffer; '' unless ok
  stdoutBuffer: Buffer; // raw bytes (empty unless ok) — for binary-safe blob reads
  code: number | null; // exit code; null when killed by timeout/abort
  notFound: boolean; // ENOENT — the binary isn't on PATH
  timedOut: boolean; // killed by our timeout
  aborted: boolean; // killed by the caller's AbortSignal
  truncated: boolean; // output exceeded maxBuffer
}

export interface GitOpts {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  stdin?: string;
}

const EMPTY = Buffer.alloc(0);

/** Run an arbitrary binary (git by default) with resource limits. Never rejects — the outcome is
 *  entirely in the returned {@link GitResult} flags so callers branch instead of try/catch. */
export function runGitBin(gitBin: string, args: string[], opts: GitOpts): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      gitBin,
      args,
      {
        cwd: opts.cwd,
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: opts.timeoutMs ?? 0, // 0 → execFile imposes no timeout
        encoding: 'buffer',
        signal: opts.signal,
      },
      (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const buf = Buffer.isBuffer(stdout) ? stdout : EMPTY;
        if (!e) {
          resolve({
            ok: true,
            stdout: buf.toString('utf8'),
            stdoutBuffer: buf,
            code: 0,
            notFound: false,
            timedOut: false,
            aborted: false,
            truncated: false,
          });
          return;
        }
        const aborted = opts.signal?.aborted === true || e.name === 'AbortError';
        const notFound = e.code === 'ENOENT';
        const truncated =
          e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(e.message ?? '');
        // execFile's own timeout kills with SIGTERM and sets `killed`; distinguish it from an abort.
        const timedOut = !aborted && e.killed === true && (opts.timeoutMs ?? 0) > 0;
        resolve({
          ok: false,
          stdout: '',
          stdoutBuffer: EMPTY,
          code: typeof e.code === 'number' ? e.code : null,
          notFound,
          timedOut,
          aborted,
          truncated,
        });
      },
    );
    if (opts.stdin != null) child.stdin?.end(opts.stdin);
  });
}

/** Run git with an arg array (never a shell string). */
export function runGit(args: string[], opts: GitOpts): Promise<GitResult> {
  return runGitBin('git', args, opts);
}

/** Map `fn` over `items` with at most `limit` in flight, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
