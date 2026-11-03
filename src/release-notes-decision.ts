export function releaseNotesDecision(
  currentVersion: string,
  lastSeenVersion: string | undefined,
  notes: string | null,
): { showToast: boolean; persistVersion: string | null } {
  if (!lastSeenVersion) return { showToast: false, persistVersion: currentVersion };
  if (!notes || compareVersions(currentVersion, lastSeenVersion) <= 0) {
    return { showToast: false, persistVersion: null };
  }
  return { showToast: true, persistVersion: currentVersion };
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
