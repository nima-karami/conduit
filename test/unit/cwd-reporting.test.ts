import { describe, expect, it } from 'vitest';
import { cwdReportingAugmentation } from '../../src/cwd-reporting';

// The exact PowerShell init string the augmentation must inject.
const PS_INIT =
  `$o=$function:prompt; function global:prompt { ` +
  `$p=$ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath; ` +
  `[Console]::Write([char]27 + ']9;9;' + $p + [char]7); ` +
  `if($o){& $o}else{'PS ' + $p + '> '} }`;

describe('cwdReportingAugmentation', () => {
  // ── PowerShell / pwsh ─────────────────────────────────────────────────────

  // The hook is delivered as a silent launch arg (`-NoExit -Command <hook>`), NOT
  // typed into stdin: PSReadLine echoes injected input, so a stdin hook shows up as a
  // visible command at the first prompt. The STATUS_CONTROL_C_EXIT crash once blamed
  // on this launch arg was a pseudoconsole resize during startup (fixed in pty-host).
  it('returns -NoExit -Command <init> args for shell:pwsh with empty baseArgs', () => {
    const result = cwdReportingAugmentation('shell:pwsh', []);
    expect(result).not.toBeNull();
    expect(result?.args).toEqual(['-NoExit', '-Command', PS_INIT]);
    expect(result?.env).toBeUndefined();
  });

  it('returns -NoExit -Command <init> args for shell:powershell with empty baseArgs', () => {
    const result = cwdReportingAugmentation('shell:powershell', []);
    expect(result).not.toBeNull();
    expect(result?.args).toEqual(['-NoExit', '-Command', PS_INIT]);
    expect(result?.env).toBeUndefined();
  });

  it('-NoExit precedes -Command, and the -Command value is exactly PS_INIT', () => {
    const result = cwdReportingAugmentation('shell:powershell', []);
    expect(result).not.toBeNull();
    const args = result?.args ?? [];
    expect(args.indexOf('-NoExit')).toBeGreaterThanOrEqual(0);
    expect(args.indexOf('-Command')).toBeGreaterThan(args.indexOf('-NoExit'));
    expect(args[args.indexOf('-Command') + 1]).toBe(PS_INIT);
  });

  it('returns null for shell:pwsh when baseArgs already contains -Command', () => {
    expect(cwdReportingAugmentation('shell:pwsh', ['-Command', 'Get-Process'])).toBeNull();
  });

  it('returns null for shell:powershell when baseArgs already contains -Command', () => {
    expect(cwdReportingAugmentation('shell:powershell', ['-Command', 'Get-Process'])).toBeNull();
  });

  it('returns null for shell:pwsh when baseArgs already contains -File', () => {
    expect(cwdReportingAugmentation('shell:pwsh', ['-File', 'script.ps1'])).toBeNull();
  });

  it('returns null when baseArgs contains -EncodedCommand (case-insensitive)', () => {
    expect(cwdReportingAugmentation('shell:pwsh', ['-EncodedCommand', 'abc'])).toBeNull();
  });

  it('returns null when baseArgs contains -c (shorthand for -Command)', () => {
    expect(cwdReportingAugmentation('shell:pwsh', ['-c', 'echo hi'])).toBeNull();
  });

  it('flag check is case-insensitive (-COMMAND should block injection)', () => {
    expect(cwdReportingAugmentation('shell:pwsh', ['-COMMAND', 'Write-Host hi'])).toBeNull();
  });

  // ── bash / gitbash ────────────────────────────────────────────────────────

  it('returns PROMPT_COMMAND env for shell:bash', () => {
    const result = cwdReportingAugmentation('shell:bash', []);
    expect(result).not.toBeNull();
    expect(result?.args).toBeUndefined();
    expect(result?.env).toBeDefined();
    expect(result?.env?.PROMPT_COMMAND).toContain(`printf '\\033]9;9;%s\\007' "$PWD"`);
  });

  it('PROMPT_COMMAND for shell:bash includes a fallback for a pre-existing PROMPT_COMMAND', () => {
    const result = cwdReportingAugmentation('shell:bash', []);
    expect(result).not.toBeNull();
    // Verify that the string contains ${PROMPT_COMMAND:-} literally (bash syntax).
    expect(result?.env?.PROMPT_COMMAND).toContain('PROMPT_COMMAND:-');
  });

  it('returns PROMPT_COMMAND env for shell:gitbash', () => {
    const result = cwdReportingAugmentation('shell:gitbash', []);
    expect(result).not.toBeNull();
    expect(result?.env?.PROMPT_COMMAND).toContain(`printf '\\033]9;9;%s\\007' "$PWD"`);
  });

  it('the OSC 9;9 emit comes BEFORE the existing PROMPT_COMMAND fallback', () => {
    const result = cwdReportingAugmentation('shell:bash', []);
    expect(result).not.toBeNull();
    const pc = result?.env?.PROMPT_COMMAND ?? '';
    const emitIdx = pc.indexOf('printf');
    const existingIdx = pc.indexOf('PROMPT_COMMAND:-');
    expect(emitIdx).toBeGreaterThanOrEqual(0);
    expect(emitIdx).toBeLessThan(existingIdx);
  });

  // ── shells NOT injected in v1 ─────────────────────────────────────────────

  it('returns null for shell:zsh', () => {
    expect(cwdReportingAugmentation('shell:zsh', [])).toBeNull();
  });

  it('returns null for shell:fish', () => {
    expect(cwdReportingAugmentation('shell:fish', [])).toBeNull();
  });

  it('returns null for shell:sh', () => {
    expect(cwdReportingAugmentation('shell:sh', [])).toBeNull();
  });

  it('returns null for shell:cmd', () => {
    expect(cwdReportingAugmentation('shell:cmd', [])).toBeNull();
  });

  it('returns null for shell:wsl', () => {
    expect(cwdReportingAugmentation('shell:wsl', [])).toBeNull();
  });

  // ── non-shell / user-configured agents ───────────────────────────────────

  it('returns null for undefined agentId (fallback shell)', () => {
    expect(cwdReportingAugmentation(undefined, [])).toBeNull();
  });

  it('returns null for a user-configured agent id (no shell: prefix)', () => {
    expect(cwdReportingAugmentation('claude', [])).toBeNull();
  });

  it('returns null for another user-configured agent id', () => {
    expect(cwdReportingAugmentation('my-custom-agent', [])).toBeNull();
  });

  // ── additive: baseArgs are never modified ─────────────────────────────────

  it('does not mutate the baseArgs array for pwsh', () => {
    const base = ['-NoProfile'];
    const original = [...base];
    cwdReportingAugmentation('shell:pwsh', base);
    expect(base).toEqual(original);
  });

  it('does not mutate the baseArgs array for bash', () => {
    const base = ['-i', '-l'];
    const original = [...base];
    cwdReportingAugmentation('shell:bash', base);
    expect(base).toEqual(original);
  });
});
