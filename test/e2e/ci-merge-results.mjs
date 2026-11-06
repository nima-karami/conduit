/**
 * Merge per-shard result JSON into the run's result JSON and decide the run status. Pure; used by
 * the `report` job of .github/workflows/e2e.yml. Spec: docs/specs/archive/2026-09-29-remote-e2e-lean-loop.md §3.
 */

const NO_ARTIFACT = new Set(['PASS', 'SKIP', 'EXCLUDED', 'INFRA']);
const FAILED = new Set(['FAIL', 'TIMEOUT']);

/**
 * First match wins (spec §3). EXCLUDED and QUARANTINED-FAIL rows are neutral, but a selection in
 * which nothing passed (all SKIP, EXCLUDED or QUARANTINED-FAIL) proved nothing. A requested `verify` job that did not succeed (a failure, or a
 * timeout's `cancelled`) fails the run; `skipped` means it was not requested. A failed `prepare`
 * planned nothing, so it is infra unless verify already failed the run.
 */
export function runStatus(results, { verify, prepare } = {}) {
  if (verify && verify !== 'success' && verify !== 'skipped') return 'failed';
  if (prepare && prepare !== 'success') return 'infra-error';
  if (results.some((r) => r.attempt != null)) {
    const ran = results.filter((r) => r.status !== 'EXCLUDED');
    if (results.length === 0) return 'passed';
    return ran.length && ran.every((r) => r.status === 'PASS') ? 'passed' : 'failed';
  }
  const ran = results.filter((r) => r.status !== 'EXCLUDED');
  const has = (s) => ran.some((r) => r.status === s);
  if (results.length === 0) return 'passed';
  if (has('FAIL') || has('TIMEOUT')) return 'failed';
  if (has('INFRA')) return 'infra-error';
  if (!ran.some((r) => r.status === 'PASS' || r.status === 'FLAKY')) return 'failed';
  if (has('FLAKY')) return 'flaky';
  return 'passed';
}

const localCommand = (name) => `npm run e2e -- ${name}`;
const QUARANTINE_RECHECK_MS = 14 * 86_400_000;

/** A quarantine is meant to be temporary (spec §B4): past 14 days, every run says so. */
function staleQuarantines(quarantine, now) {
  return Object.entries(quarantine?.scenarios ?? {})
    .filter(([, q]) => now - Date.parse(q.since) > QUARANTINE_RECHECK_MS)
    .map(([name, q]) => `${name}: quarantined > 14 days (since ${q.since}) — re-check`);
}

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
 *   quarantine?: { scenarios?: Record<string, { reason: string, since: string }> } | null,
 *   quarantineCandidates?: { name: string, count: number, last: string }[] }} meta
 */
function decorate(row, shard, meta) {
  const out = { ...row, shard };
  const artifact = meta.artifactUrls?.[shard];
  if (artifact && !NO_ARTIFACT.has(out.status)) out.artifact = artifact;
  if (FAILED.has(out.status) && meta.lastNightly?.failing.includes(out.name)) {
    out.alsoFailingOnNightly = true;
  }
  return out;
}

export function mergeResults(plan, shardFiles, meta) {
  const attempted = shardFiles.some((f) => f.results.some((r) => r.attempt != null));
  const results = [];
  if (attempted) {
    for (const f of shardFiles) {
      for (const r of f.results) results.push(decorate(r, f.shard, meta));
    }
    const seen = new Set(results.map((r) => r.name));
    for (const s of plan.shards) {
      for (const name of s.names) {
        if (seen.has(name)) continue;
        results.push(
          decorate({ name, status: 'INFRA', seconds: 0, attempt: 0 }, s.index + 1, meta),
        );
        seen.add(name);
      }
    }
  } else {
    const got = new Map();
    for (const f of shardFiles)
      for (const r of f.results) got.set(r.name, { ...r, shard: f.shard });
    for (const s of plan.shards) {
      const shard = s.index + 1;
      for (const name of s.names) {
        const r = got.get(name);
        const row = r
          ? { name, status: r.status, seconds: r.seconds, attempts: r.attempts ?? 1, shard }
          : { name, status: 'INFRA', seconds: 0, attempts: 0, shard };
        results.push(decorate(row, shard, meta));
      }
    }
  }
  for (const [name, reason] of Object.entries(meta.excluded ?? {})) {
    results.push({ name, status: 'EXCLUDED', seconds: 0, attempts: 0, shard: null, reason });
  }
  results.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.shard ?? 0) - (b.shard ?? 0) ||
      (a.attempt ?? 0) - (b.attempt ?? 0),
  );
  const {
    artifactUrls: _a,
    excluded: _e,
    quarantine,
    lastNightly,
    quarantineCandidates = [],
    ...rest
  } = meta;
  const now = meta.finishedAt ? Date.parse(meta.finishedAt) : Date.now();
  return {
    ...rest,
    warnings: staleQuarantines(quarantine, now),
    lastNightlySha: lastNightly?.sha ?? null,
    quarantineCandidates,
    shards: plan.shards.length,
    status: runStatus(results, { verify: meta.verify, prepare: meta.prepare }),
    rerun: infraRerunLine(results, meta.sha),
    results,
  };
}

const ORDER = ['FLAKY', 'FAIL', 'TIMEOUT', 'INFRA', 'QUARANTINED-FAIL', 'EXCLUDED', 'SKIP', 'PASS'];

/** Per-scenario pass rate when result rows carry `attempt` (CON-143). */
export function repeatRates(results) {
  if (!results.some((r) => r.attempt != null)) return [];
  const order = [];
  const byName = new Map();
  for (const r of results) {
    if (r.status === 'EXCLUDED' || r.attempt == null) continue;
    if (!byName.has(r.name)) {
      byName.set(r.name, { name: r.name, passed: 0, total: 0, failures: [] });
      order.push(r.name);
    }
    const g = byName.get(r.name);
    g.total++;
    if (r.status === 'PASS') g.passed++;
    else g.failures.push(`${r.status}@${r.shard}#${r.attempt}`);
  }
  return order.map((n) => byName.get(n));
}

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
  for (const w of result.warnings ?? []) md += `> **Warning:** ${w}\n\n`;
  if (result.quarantineCandidates?.length) {
    md += 'Quarantine candidates (FLAKY 3+ times in 14 days of nightlies; a reviewed edit to ';
    md += '`test/e2e/quarantine.json` quarantines one):\n\n';
    for (const c of result.quarantineCandidates) {
      md += `- ${c.name}: FLAKY ${c.count}, last ${c.last}\n`;
    }
    md += '\n';
  }
  const rates = repeatRates(result.results);
  if (rates.length) {
    md += '### Repeat run\n\n| name | passed/total | failures |\n|---|---|---|\n';
    for (const g of rates) {
      md += `| ${g.name} | ${g.passed}/${g.total} | ${g.failures.join(', ')} |\n`;
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
