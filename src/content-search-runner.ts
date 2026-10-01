import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ContentSearchResponse, SearchQuery } from './content-search';

export interface RegexSearchRequest {
  root: string;
  query: SearchQuery;
  files?: { abs: string; rel: string }[];
}

interface SearchJob {
  start: () => void;
}

const MAX_WORKERS = 2;
const MAX_QUEUED = 8;
// The core's 2 s search budget plus 500 ms for worker startup; queue time counts too.
const DEADLINE_MS = 2500;
const CANCEL_POLL_MS = 50;
const queued: SearchJob[] = [];
let active = 0;

function drain(): void {
  while (active < MAX_WORKERS && queued.length > 0) queued.shift()?.start();
}

export function runRegexSearch(
  request: RegexSearchRequest,
  isCancelled?: () => boolean,
): Promise<ContentSearchResponse> {
  if (isCancelled?.()) return Promise.resolve({ files: [], truncated: true });
  if (active >= MAX_WORKERS && queued.length >= MAX_QUEUED) {
    return Promise.resolve({ files: [], truncated: true, error: 'Too many searches are running.' });
  }
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let running = false;
    let settled = false;
    const job: SearchJob = { start };
    const deadline = setTimeout(() => {
      finish({ files: [], truncated: true, error: 'Search exceeded its time limit.' });
    }, DEADLINE_MS);
    const cancellation = isCancelled
      ? setInterval(() => {
          if (isCancelled()) finish({ files: [], truncated: true });
        }, CANCEL_POLL_MS)
      : undefined;

    function release(result: ContentSearchResponse): void {
      if (running) active--;
      resolve(result);
      drain();
    }

    function finish(result: ContentSearchResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (cancellation) clearInterval(cancellation);
      const index = queued.indexOf(job);
      if (index >= 0) queued.splice(index, 1);
      if (worker) {
        void worker.terminate().then(
          () => release(result),
          () => release(result),
        );
      } else release(result);
    }

    function start(): void {
      if (settled) return;
      running = true;
      active++;
      try {
        worker = new Worker(path.join(__dirname, 'content-search-worker.js'), {
          workerData: request,
        });
        worker.on('message', (result: ContentSearchResponse) => finish(result));
        worker.on('error', (error: unknown) =>
          finish({
            files: [],
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        worker.on('exit', () => {
          if (!settled)
            finish({ files: [], truncated: false, error: 'Search worker exited without results.' });
        });
      } catch (error) {
        finish({
          files: [],
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (active < MAX_WORKERS) start();
    else queued.push(job);
  });
}
