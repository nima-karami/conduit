export interface AuditException {
  id: string;
  package: string;
  lastVulnerable: string;
  expires: string;
  reason: string;
}

export function judgeAudit(input: {
  full: object;
  prod: object;
  allowlist: AuditException[];
  latest: Record<string, string>;
  today: string;
}): { failures: string[]; allowed: string[] };
