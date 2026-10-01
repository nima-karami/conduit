import { parentPort, workerData } from 'node:worker_threads';
import { searchContentAsync } from './content-search';
import { hostAsyncDeps } from './content-search-fs';
import type { RegexSearchRequest } from './content-search-runner';

const request: RegexSearchRequest = workerData;
void searchContentAsync(request.root, request.query, hostAsyncDeps(undefined, request.files)).then(
  (result) => parentPort?.postMessage(result),
  (error: unknown) =>
    parentPort?.postMessage({
      files: [],
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    }),
);
