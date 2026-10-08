/**
 * Shared by csharp-lsp and csharp-lsp-idle: the C# fixture and the "is csharp-ls installed" probe
 * (docs/specs/archive/2026-10-08-language-support.md §7 Lane B). The generic host-side LSP waits
 * live in lsp-fixture.mjs.
 */
import { spawnSync } from 'node:child_process';
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
