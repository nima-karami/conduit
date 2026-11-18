/** Save a complete assignment through the same tokened owner path as the UI. */
export async function assignProfileCas(
  c2,
  point,
  profileId,
  { machine, claimSessions = false } = {},
) {
  let snapshot = await c2.call('events.subscribe');
  if (claimSessions) {
    const ownedSessionIds = snapshot.sessions.map(({ id }) => id);
    await c2.call('ui.presence', {
      windows: [
        { windowId: 1, focused: true, ready: true, visibleSessionIds: [], ownedSessionIds },
      ],
    });
    snapshot = await c2.call('events.subscribe');
  }
  const policy =
    machine === undefined
      ? snapshot.mcp.policy
      : snapshot.mcp.policy.machines.find((row) => row.machineId === machine)?.policy;
  if (!policy || typeof policy.editToken !== 'string') throw new Error('Missing policy edit token');
  const samePoint = (a, b) =>
    a.kind === b.kind &&
    (a.kind === 'default' ||
      (a.kind === 'session' && a.sessionId === b.sessionId) ||
      (a.kind === 'cli' && a.cli === b.cli) ||
      (a.kind === 'peer' && a.machineId === b.machineId));
  const existing = policy.assignments.find((entry) => samePoint(entry.point, point))?.assignment;
  const assignment =
    profileId === null
      ? null
      : {
          ...(existing ?? { exceptions: [], onScreenOnly: false }),
          profileId,
        };
  const message =
    machine === undefined
      ? {
          type: 'mcp:saveAssignment',
          requestId: 1,
          point,
          assignment,
          expectedToken: policy.editToken,
        }
      : {
          type: 'mcp:remoteEdit',
          requestId: 1,
          machine,
          expectedToken: policy.editToken,
          edit: { kind: 'assignment', point, assignment },
        };
  try {
    return await c2.call('mcp.fromRenderer', { windowId: 1, message });
  } finally {
    if (claimSessions) {
      await c2.call('ui.presence', {
        windows: [
          { windowId: 1, focused: true, ready: true, visibleSessionIds: [], ownedSessionIds: [] },
        ],
      });
    }
  }
}

/** Submit an already chosen full assignment; any native review must be supplied explicitly. */
export async function saveAssignmentPage(page, point, assignment, expectedToken, nativeReview) {
  return page.evaluate(
    ({ point, assignment, expectedToken, nativeReview }) =>
      new Promise((resolve, reject) => {
        window.__policyReq = (window.__policyReq ?? 900_000) + 1;
        const requestId = window.__policyReq;
        const timer = setTimeout(() => {
          off();
          reject(new Error('mcp:saveAssignment timed out'));
        }, 10_000);
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'mcp:policyEditResult' || m.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          resolve(m.result);
        });
        window.agentDeck.post({
          type: 'mcp:saveAssignment',
          requestId,
          point,
          assignment,
          expectedToken,
          ...(nativeReview === undefined ? {} : { nativeReview }),
        });
      }),
    { point, assignment, expectedToken, nativeReview },
  );
}

/** Use the live renderer's owner identity for a session assignment. */
export async function assignLocalSessionProfile(page, c2, sessionId, profileId) {
  const { policy } = (await c2.call('events.subscribe')).mcp;
  const point = { kind: 'session', sessionId };
  const existing = policy.assignments.find(
    (entry) => entry.point.kind === 'session' && entry.point.sessionId === sessionId,
  )?.assignment;
  return saveAssignmentPage(
    page,
    point,
    { ...(existing ?? { exceptions: [], onScreenOnly: false }), profileId },
    policy.editToken,
  );
}

let projectionModule;

/** Build a fixture assignment with the same legacy-to-assignment projection used by the host. */
export async function projectedAssignment(policy, point, lower, tool, patch) {
  projectionModule ??= (async () => {
    const { build } = await import('esbuild');
    const { fileURLToPath } = await import('node:url');
    const entry = fileURLToPath(
      new URL('../../src/conduit-mcp/policy-projection.ts', import.meta.url),
    );
    const output = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
    });
    return import(
      `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`
    );
  })();
  const module = await projectionModule;
  const key = (p) =>
    p.kind === 'default' ? 'default' : `${p.kind}:${p.sessionId ?? p.machineId ?? p.cli}`;
  return module.applyLegacyPatch(
    {
      profiles: policy.profiles,
      assignments: new Map(policy.assignments.map((entry) => [key(entry.point), entry.assignment])),
      grants: [],
      overrides: [],
      sessionDenials: [],
      failClosed: false,
    },
    point,
    lower,
    tool,
    patch,
  );
}
