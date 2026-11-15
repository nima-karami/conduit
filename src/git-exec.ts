// One bounded, cancellable git runner. Every git spawn in the app routes through here so timeouts,
// output caps, and cancellation are uniform. See docs/specs/archive/2026-07-07-git-host-robustness.md.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

// Default per-call deadlines by operation weight (ms). Callers pass one of these or their own.
export const GIT_TIMEOUT = { metadata: 2000, diff: 10000, history: 5000, blame: 10000 } as const;

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitResult {
  ok: boolean; // true iff the process exited 0 within all limits and took all of its stdin
  stdout: string; // utf8 decode of stdoutBuffer; '' unless ok
  stdoutBuffer: Buffer; // raw bytes (empty unless ok) — for binary-safe blob reads
  stderr: string; // utf8 stderr (for surfacing git action failure messages)
  code: number | null; // exit code; null when killed by timeout/abort
  notFound: boolean; // ENOENT with the cwd present — the binary isn't on PATH
  cwdMissing?: boolean; // ENOENT because the cwd is gone (e.g. a removed worktree), not the binary
  timedOut: boolean; // killed by our timeout
  aborted: boolean; // killed by the caller's AbortSignal
  truncated: boolean; // output exceeded maxBuffer
}

export type GitFailure = 'timeout' | 'not-found' | 'failed';

/** undefined when r.ok. */
export function gitFailureOf(r: GitResult): GitFailure | undefined {
  if (r.ok) return undefined;
  if (r.timedOut) return 'timeout';
  if (r.notFound) return 'not-found';
  return 'failed';
}

/** Copy for a failure git printed nothing about, so a gone folder never reads as an exit code. */
export function gitFailureText(r: GitResult, fallback: string): string {
  if (r.cwdMissing) return 'folder not found';
  if (r.notFound) return 'git not found';
  return fallback;
}

export interface GitOpts {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  stdin?: string;
}

const EMPTY = Buffer.alloc(0);

// A child that exits without reading all of its stdin fails our pending write with one of these.
// Its exit code already carries the outcome. See docs/specs/2026-11-14-linux-sigtrap.md (B1).
const EARLY_EXIT_STDIN_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

/** Fold a stdin delivery error into the result: an early exit's EPIPE changes nothing, any other
 *  error means the child never got its input, so its output can't be trusted. */
export function withStdinError(r: GitResult, err: NodeJS.ErrnoException | undefined): GitResult {
  if (!err || EARLY_EXIT_STDIN_CODES.has(err.code ?? '')) return r;
  const note = `stdin: ${err.message}`;
  return {
    ...r,
    ok: false,
    stdout: '',
    stdoutBuffer: EMPTY,
    stderr: r.stderr ? `${r.stderr}\n${note}` : note,
  };
}

/** Run an arbitrary binary (git by default) with resource limits. Never rejects — the outcome is
 *  entirely in the returned {@link GitResult} flags so callers branch instead of try/catch. */
export function runGitBin(gitBin: string, args: string[], opts: GitOpts): Promise<GitResult> {
  return new Promise((resolve) => {
    // Resolve only once stdin has settled too, so a delivery error always reaches the result.
    let stdinSettled: Promise<NodeJS.ErrnoException | undefined> = Promise.resolve(undefined);
    const settle = (r: GitResult) => {
      void stdinSettled.then((err) => resolve(withStdinError(r, err)));
    };
    const child = execFile(
      gitBin,
      args,
      {
        cwd: opts.cwd,
        // Without this, `git status` refreshes the index's stat cache and rewrites `.git/index`;
        // the project watcher sees that, re-runs `git status`, and an idle repo loops on its own
        // `fsChanged` (~3/s). Mutating commands take their required locks regardless.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: opts.timeoutMs ?? 0, // 0 → execFile imposes no timeout
        encoding: 'buffer',
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const buf = Buffer.isBuffer(stdout) ? stdout : EMPTY;
        const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
        if (!e) {
          settle({
            ok: true,
            stdout: buf.toString('utf8'),
            stdoutBuffer: buf,
            stderr: errText,
            code: 0,
            notFound: false,
            timedOut: false,
            aborted: false,
            truncated: false,
          });
          return;
        }
        const aborted = opts.signal?.aborted === true || e.name === 'AbortError';
        // spawn reports a missing cwd as ENOENT too; reading that as "no git" latches every later
        // interrogation off (multi-repo-tracking engine review r2).
        const enoent = e.code === 'ENOENT';
        const cwdMissing = enoent && !!opts.cwd && !existsSync(opts.cwd);
        const notFound = enoent && !cwdMissing;
        const truncated =
          e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(e.message ?? '');
        // execFile's own timeout kills with SIGTERM and sets `killed`; distinguish it from an abort.
        const timedOut = !aborted && e.killed === true && (opts.timeoutMs ?? 0) > 0;
        settle({
          ok: false,
          stdout: '',
          stdoutBuffer: EMPTY,
          stderr: errText,
          code: typeof e.code === 'number' ? e.code : null,
          notFound,
          ...(cwdMissing ? { cwdMissing } : {}),
          timedOut,
          aborted,
          truncated,
        });
      },
    );
    const stdin = child.stdin;
    if (opts.stdin != null && stdin) {
      // Without an 'error' listener, the EPIPE from a child that exits early is an uncaught
      // exception in main. See docs/specs/2026-11-14-linux-sigtrap.md (B1).
      stdinSettled = new Promise((done) => {
        stdin.on('error', (err: NodeJS.ErrnoException) => done(err));
        stdin.on('close', () => done(undefined));
      });
      stdin.end(opts.stdin);
    }
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
