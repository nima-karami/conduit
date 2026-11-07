import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Playwright's `waitForFunction` treats a Promise returned by the predicate as truthy before it
 * settles, so an async predicate passes on its first poll. Best-effort source scan: a predicate
 * that is `async`, or an arrow whose expression body is a `window.fn(...)`, `window.agentDeck.*` or `fetch(...)` call.
 * Use a Node-side `pollUntil` (test/e2e/harness.mjs) for anything that needs an async query.
 */

const E2E = join(__dirname, '..', 'e2e');

function mjsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? mjsFiles(join(dir, d.name))
      : d.name.endsWith('.mjs')
        ? [join(dir, d.name)]
        : [],
  );
}

const ASYNC_PREDICATE = /waitForFunction\(\s*async\b/;
const PROMISE_EXPRESSION_BODY =
  /waitForFunction\(\s*(?:\([^)]*\)|\w+)\s*=>\s*(?:window\.agentDeck\.|window\.\w+\(|fetch\()/;

describe('e2e waitForFunction predicates', () => {
  it('are synchronous', () => {
    const offenders = mjsFiles(E2E).flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return src.split('\n').flatMap((_, i, lines) => {
        const window = lines.slice(i, i + 2).join('\n');
        return lines[i].includes('waitForFunction(') &&
          (ASYNC_PREDICATE.test(window) || PROMISE_EXPRESSION_BODY.test(window))
          ? [`${relative(E2E, f).replace(/\\/g, '/')}:${i + 1}`]
          : [];
      });
    });
    expect(offenders).toEqual([]);
  });
});
