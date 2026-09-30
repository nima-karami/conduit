/**
 * Merge per-shard result JSON into the run's result JSON and decide the run status. Pure; used by
 * the `report` job of .github/workflows/e2e.yml. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §3.
 */

const NO_ARTIFACT = new Set(['PASS', 'SKIP', 'EXCLUDED', 'INFRA']);
const FAILED = new Set(['FAIL', 'TIMEOUT']);

/**
 * First match wins (spec §3). EXCLUDED and QUARANTINED-FAIL rows are neutral, but a selection where nothing ran at all
 * is as vacuous as an all-SKIP one. A requested `verify` job that did not succeed (a failure, or a
 * timeout's `cancelled`) fails the run; `skipped` means it was not requested. A failed `prepare`
 * planned nothing, so it is infra unless verify already failed the run.
 */
export function runStatus(results, { verify, prepare } = {}) {
  if (verify && verify !== 'success' && verify !== 'skipped') return 'failed';
  if (prepare && prepare !== 'success') return 'infra-error';
  const ran = results.filter((r) => r.status !== 'EXCLUDED');
  const has = (s) => ran.some((r) => r.status === s);
  if (results.length === 0) return 'passed';
  if (has('FAIL') || has('TIMEOUT')) return 'failed';
  if (has('INFRA')) return 'infra-error';
  if (ran.every((r) => r.status === 'SKIP')) return 'failed';
  if (has('FLAKY')) return 'flaky-passed';
  return 'passed';
}

const localCommand = (name) => `npm run e2e -- ${name}`;

export function infraRerunLine(results, sha) {
  const names = results.filter((r) => r.status === 'INFRA').map((r) => r.name);
  if (!names.length) return null;
  const at = sha ? ` (at ${sha.slice(0, 7)})` : '';
  return `npm run e2e:remote -- ${names.join(' ')}${at}`;
}

/**
 * @param {{ shards: { index: number, names: string[] }[] }} plan  shard n is `index + 1`
 * @param {{ shard: number, results: { name: string, status: string, seconds: number, attempts?: number }[] }[]} shardFiles
 * @param {{ sha: string, nonce: string, selection: string, runId?: number, url?: string,
 *   queuedAt?: string, startedAt?: string, finishedAt?: string, verify?: string, prepare?: string,
 *   artifactUrls?: Record<number, string>, excluded?: Record<string, string>,
 *   lastNightly?: { sha: string, failing: string[] } | null,
 *   quarantineCandidates?: { name: string, count: number, last: string }[] }} meta
 */
export function mergeResults(plan, shardFiles, meta) {
  const got = new Map();
  for (const f of shardFiles) for (const r of f.results) got.set(r.name, { ...r, shard: f.shard });
  const results = [];
  for (const s of plan.shards) {
    const shard = s.index + 1;
    for (const name of s.names) {
      const r = got.get(name);
      const row = r
        ? { name, status: r.status, seconds: r.seconds, attempts: r.attempts ?? 1, shard }
        : { name, status: 'INFRA', seconds: 0, attempts: 0, shard };
      const artifact = meta.artifactUrls?.[shard];
      if (artifact && !NO_ARTIFACT.has(row.status)) row.artifact = artifact;
      if (FAILED.has(row.status) && meta.lastNightly?.failing.includes(name)) {
        row.alsoFailingOnNightly = true;
      }
      results.push(row);
    }
  }
  for (const [name, reason] of Object.entries(meta.excluded ?? {})) {
    results.push({ name, status: 'EXCLUDED', seconds: 0, attempts: 0, shard: null, reason });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  const { artifactUrls: _a, excluded: _e, lastNightly, quarantineCandidates = [], ...rest } = meta;
  return {
    ...rest,
    lastNightlySha: lastNightly?.sha ?? null,
    quarantineCandidates,
    shards: plan.shards.length,
    status: runStatus(results, { verify: meta.verify, prepare: meta.prepare }),
    rerun: infraRerunLine(results, meta.sha),
    results,
  };
}

const ORDER = ['FAIL', 'TIMEOUT', 'INFRA', 'QUARANTINED-FAIL', 'FLAKY', 'EXCLUDED', 'SKIP', 'PASS'];

export function countByStatus(results) {
  const c = {};
  for (const r of results) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

export function summaryMarkdown(result) {
  const c = countByStatus(result.results);
  const parts = ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${s}`);
  let md = `## e2e ${result.status}: ${parts.join(', ') || 'no scenarios'}\n\n`;
  if (result.verify) md += `verify job: **${result.verify}**\n\n`;
  if (result.rerun) md += `Re-run the INFRA scenarios: \`${result.rerun}\`\n\n`;
  if (result.quarantineCandidates?.length) {
    md += 'Quarantine candidates (FLAKY 3+ times in 14 days of nightlies; a reviewed edit to ';
    md += '`test/e2e/quarantine.json` quarantines one):\n\n';
    for (const c of result.quarantineCandidates) {
      md += `- ${c.name}: FLAKY ${c.count}, last ${c.last}\n`;
    }
    md += '\n';
  }
  const rows = [...result.results].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name),
  );
  md +=
    '| scenario | status | s | attempts | shard | artifacts / reason |\n|---|---|---|---|---|---|\n';
  for (const r of rows) {
    let extra = r.reason ?? '';
    if (r.artifact) extra = `[e2e-fail-${r.shard}](${r.artifact})`;
    else if (r.status === 'EXCLUDED') extra += `; run locally: \`${localCommand(r.name)}\``;
    if (r.alsoFailingOnNightly) {
      extra += ` also failing on the last nightly (${result.lastNightlySha?.slice(0, 7)})`;
    }
    md += `| ${r.name} | ${r.status} | ${r.seconds} | ${r.attempts} | ${r.shard ?? ''} | ${extra} |\n`;
  }
  return md;
}
