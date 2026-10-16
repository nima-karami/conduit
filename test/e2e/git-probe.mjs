/**
 * Test-only counter of every git process the main process spawns. Patches `execFile` on the
 * `child_process` builtin inside main, the same seam `nested-repo-resources.e2e.mjs` probes:
 * `runGitBin` (src/git-exec.ts) reads the property at call time, so the patch sees every call.
 */

const PROBE_CAP = 200000;

/** @param app Playwright ElectronApplication (the harness resolves playwright by path, never by bare import) */
export async function installGitProbe(app) {
  await app.evaluate((_electron, cap) => {
    if (globalThis.__gitProbe) return;
    const cp = process.getBuiltinModule('child_process');
    const original = cp.execFile;
    const probe = { calls: [], cap };
    globalThis.__gitProbe = probe;
    cp.execFile = function (file, args, options, ...rest) {
      if (/(^|[\\/])git(\.exe)?$/i.test(String(file))) {
        const list = Array.isArray(args) ? args.map(String) : [];
        probe.calls.push({
          at: Date.now(),
          cwd: String(options?.cwd ?? '')
            .replace(/\\/g, '/')
            .toLowerCase(),
          sub: list[0] ?? '',
          args: list.slice(0, 4),
        });
        // A runaway loop must not grow main's heap without bound while a scenario waits.
        if (probe.calls.length > probe.cap) probe.calls.splice(0, probe.calls.length - probe.cap);
      }
      return original.call(this, file, args, options, ...rest);
    };
  }, PROBE_CAP);
}

/** @param app Playwright ElectronApplication (the harness resolves playwright by path, never by bare import) */
export async function resetGitProbe(app) {
  await app.evaluate(() => {
    if (globalThis.__gitProbe) globalThis.__gitProbe.calls = [];
  });
}

/**
 * @param app Playwright ElectronApplication (the harness resolves playwright by path, never by bare import)
 * @returns {Promise<Array<{at:number; cwd:string; sub:string; args:string[]}>>}
 */
export async function readGitProbe(app) {
  return app.evaluate(() => globalThis.__gitProbe?.calls ?? []);
}

/** The change-list read: `status --porcelain -z --untracked-files=all` (src/project-info.ts). */
export function statusCalls(calls) {
  return calls.filter((c) => c.sub === 'status' && c.args.includes('--untracked-files=all'));
}

export function numstatCalls(calls) {
  return calls.filter((c) => c.sub === 'diff' && c.args.includes('--numstat'));
}
