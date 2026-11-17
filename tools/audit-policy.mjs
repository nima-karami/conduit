// Pure judgement for the audit gate (tools/audit-gate.mjs), kept free of I/O so each rule is
// unit-tested. An exception is owner-approved, names one advisory, covers dev dependencies only,
// and lapses on its own: at its expiry date, or as soon as a fixed release exists.

const BLOCKING = new Set(['high', 'critical']);

function advisoryId(url) {
  const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/.exec(url ?? '');
  return m ? m[0] : (url ?? 'unknown');
}

function blockingAdvisories(report) {
  const out = new Map();
  for (const vuln of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === 'object' && BLOCKING.has(via.severity)) {
        out.set(advisoryId(via.url), { id: advisoryId(via.url), name: via.name, range: via.range });
      }
    }
  }
  return out;
}

function newerThan(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/**
 * @param {{ full: object, prod: object, allowlist: Array<{id:string,package:string,lastVulnerable:string,expires:string,reason:string}>, latest: Record<string,string>, today: string }} input
 * @returns {{ failures: string[], allowed: string[] }}
 */
export function judgeAudit({ full, prod, allowlist, latest, today }) {
  const failures = [];
  const allowed = [];
  const entries = new Map(allowlist.map((e) => [e.id, e]));
  const prodBlocking = blockingAdvisories(prod);

  for (const adv of blockingAdvisories(full).values()) {
    const entry = entries.get(adv.id);
    if (!entry) {
      failures.push(`${adv.id} (${adv.name} ${adv.range}) has no approved exception`);
    } else if (prodBlocking.has(adv.id)) {
      failures.push(`${adv.id} now reaches a production dependency; the exception covers dev only`);
    } else if (today > entry.expires) {
      failures.push(`${adv.id}: the exception expired on ${entry.expires}`);
    } else if (latest[entry.package] && newerThan(latest[entry.package], entry.lastVulnerable)) {
      failures.push(
        `${adv.id}: ${entry.package} ${latest[entry.package]} is out; upgrade and remove the exception`,
      );
    } else {
      allowed.push(`${adv.id} (${adv.name}, dev only, until ${entry.expires}): ${entry.reason}`);
    }
  }
  return { failures, allowed };
}
