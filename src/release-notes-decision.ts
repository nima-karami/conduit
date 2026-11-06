export function releaseNotesDecision(
  currentVersion: string,
  lastSeenVersion: string | undefined,
  notes: string | null,
  settingsFileExistedAtLoad: boolean,
): { showToast: boolean; persistVersion: string | null } {
  if (!isStableVersion(currentVersion)) return { showToast: false, persistVersion: null };
  if (!settingsFileExistedAtLoad) {
    return { showToast: false, persistVersion: currentVersion };
  }
  if (!lastSeenVersion) {
    return notes
      ? { showToast: true, persistVersion: null }
      : { showToast: false, persistVersion: null };
  }
  if (!isStableVersion(lastSeenVersion)) return { showToast: false, persistVersion: null };
  if (!notes || compareVersions(currentVersion, lastSeenVersion) <= 0) {
    return { showToast: false, persistVersion: null };
  }
  return { showToast: true, persistVersion: null };
}

export function releaseNotesAckVersion(
  offeredVersion: string | undefined,
  acknowledgedVersion: string,
): string | null {
  return offeredVersion === acknowledgedVersion && isStableVersion(acknowledgedVersion)
    ? acknowledgedVersion
    : null;
}

function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
