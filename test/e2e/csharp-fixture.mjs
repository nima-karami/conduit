/**
 * Shared by csharp-lsp and csharp-lsp-idle: the C# fixture, the "is csharp-ls installed" probe and
 * the host-side LSP waits (docs/specs/2026-10-08-language-support.md §7 Lane B).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assert } from './harness.mjs';

export const READY_CEILING_MS = 150_000;
export const CSHARP_TOOLS = /csharp-ls|dotnet/i;

/** `g.Greet("x")` in Program.cs, 0-based for `lsp:request`. */
export const GREET_CALL = {
  line: 7,
  character: 8 + 'System.Console.WriteLine(g.Greet("x"));'.indexOf('Greet'),
};

const PROJECT_GUID = '{6F1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D}';

/** `App.sln` → `src/App/App.csproj` → `Program.cs` calling `Greeter.Greet` in `Greeter.cs`. */
export function writeCsharpFixture(dir) {
  const app = join(dir, 'src', 'App');
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(dir, 'App.sln'),
    [
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      '# Visual Studio Version 17',
      'VisualStudioVersion = 17.0.31903.59',
      'MinimumVisualStudioVersion = 10.0.40219.1',
      `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "${PROJECT_GUID}"`,
      'EndProject',
      'Global',
      '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
      '\t\tDebug|Any CPU = Debug|Any CPU',
      '\tEndGlobalSection',
      '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
      `\t\t${PROJECT_GUID}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
      `\t\t${PROJECT_GUID}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
      '\tEndGlobalSection',
      'EndGlobal',
      '',
    ].join('\r\n'),
  );
  writeFileSync(
    join(app, 'App.csproj'),
    '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
  );
  writeFileSync(
    join(app, 'Program.cs'),
    'namespace App;\n\npublic static class Program\n{\n    public static void Main()\n    {\n        var g = new Greeter();\n        System.Console.WriteLine(g.Greet("x"));\n    }\n}\n',
  );
  writeFileSync(
    join(app, 'Greeter.cs'),
    'namespace App;\n\n/// <summary>Says hi.</summary>\npublic class Greeter\n{\n    /// <summary>Greets by name.</summary>\n    public string Greet(string name) => "hi " + name;\n}\n',
  );
  return { program: join(app, 'Program.cs') };
}

/** csharp-ls loads projects through MSBuild without restoring them; an unrestored SDK project has
 *  no assets file, so restore it up front the way a developer's tree would already be. */
export function restoreFixture(dir, log) {
  // No build servers or reused MSBuild nodes: they outlive the restore and would show up as
  // dotnet processes in the scenarios' process-tree assertions.
  const r = spawnSync('dotnet', ['restore', join(dir, 'App.sln'), '--disable-build-servers'], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, MSBUILDDISABLENODEREUSE: '1' },
  });
  log(`dotnet restore → status ${r.status} ${(r.stdout ?? '').trim().split('\n').at(-1) ?? ''}`);
  assert(r.status === 0, `dotnet restore failed: ${r.stderr || r.stdout || r.error}`);
}

/** The host's own lookup is richer (lsp-registry CSHARP_SERVER); this only tells installed from not. */
export function csharpLsInstalled() {
  if (spawnSync('where', ['csharp-ls'], { stdio: 'ignore' }).status === 0) return true;
  return existsSync(join(homedir(), '.dotnet', 'tools', 'csharp-ls.exe'));
}

/** `pid` and every descendant, by ParentProcessId walk. */
export function recordTree(pid) {
  const json = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const procs = JSON.parse(json);
  const tree = [{ pid, name: procs.find((p) => p.ProcessId === pid)?.Name ?? '?' }];
  for (let i = 0; i < tree.length; i++) {
    for (const p of procs) {
      if (p.ParentProcessId === tree[i].pid) tree.push({ pid: p.ProcessId, name: p.Name });
    }
  }
  return tree;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function survivorsAfter(tree, ms) {
  const deadline = Date.now() + ms;
  let left = tree;
  while (Date.now() < deadline) {
    left = tree.filter((p) => alive(p.pid));
    if (left.length === 0) return [];
    await new Promise((r) => setTimeout(r, 200));
  }
  return left;
}

export const lsp = (page, msg) => page.evaluate((m) => window.agentDeck.lsp(m), msg);

/** The C# server's status entry once it is in `state`, failing on absent/crashed on the way. */
export async function waitCsState(page, state, log, ms = 30_000) {
  const t0 = Date.now();
  let snap = null;
  while (Date.now() - t0 < ms) {
    snap = await lsp(page, { type: 'lsp:statusSnapshot' });
    const cs = snap.servers.filter((s) => s.languageId === 'csharp');
    const hit = cs.find((s) => s.state === state);
    if (hit) {
      log(`csharp-ls ${state} in ${((Date.now() - t0) / 1000).toFixed(1)}s (pid ${hit.pid})`);
      return hit;
    }
    if (state !== 'absent') {
      const bad = cs.find((s) => s.state === 'absent' || s.state === 'crashed');
      assert(!bad, `csharp-ls went ${bad?.state}: ${JSON.stringify(bad)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(false, `csharp-ls never reached ${state} within ${ms / 1000}s: ${JSON.stringify(snap)}`);
}

/** Definition over the bridge until the server's project load answers it — `ready` means
 *  initialized, and the solution may still be evaluating. */
export async function waitDefinition(page, path, line, character, log, ms) {
  const t0 = Date.now();
  let last = null;
  let n = 0;
  while (Date.now() - t0 < ms) {
    last = await lsp(page, {
      type: 'lsp:request',
      requestId: `cs-def-${++n}`,
      path,
      version: 1,
      op: 'definition',
      line,
      character,
    });
    if (last.kind === 'locations' && last.locations.length > 0) {
      log(`definition answered after ${((Date.now() - t0) / 1000).toFixed(1)}s (${n} asks)`);
      return last;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  assert(false, `no definition within ${ms / 1000}s: ${JSON.stringify(last)}`);
}

/** Trust through the host's own prompt flow — what the prompt's Trust button sends. */
export async function trustViaHost(page, path, log) {
  const asked = await lsp(page, { type: 'lsp:trustRequest', path, languageId: 'csharp' });
  assert(asked.ok, `trust request refused for ${path}`);
  const t0 = Date.now();
  let state = await lsp(page, { type: 'lsp:trustState' });
  while (!state.prompt && Date.now() - t0 < 10_000) {
    await new Promise((r) => setTimeout(r, 100));
    state = await lsp(page, { type: 'lsp:trustState' });
  }
  assert(state.prompt, 'the host raised no trust prompt');
  const answered = await lsp(page, {
    type: 'lsp:trustAnswer',
    promptId: state.prompt.id,
    choice: 'trust',
  });
  assert(answered.ok, 'the host refused the trust answer');
  log(`trusted ${state.prompt.folder} through the host prompt`);
}
