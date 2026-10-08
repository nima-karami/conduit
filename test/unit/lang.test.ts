import { describe, expect, it } from 'vitest';
import { isGoldenPath, langFromPath, languageDisplayName } from '../../src/lang';

describe('langFromPath — Go module files', () => {
  it('maps go.mod and go.work to gomod, whatever the case or separator', () => {
    for (const p of ['go.mod', 'GO.MOD', 'repo/go.mod', 'sub\\dir\\go.work', 'Go.Work']) {
      expect(langFromPath(p)).toBe('gomod');
    }
  });

  it('keeps go.sum and go.work.sum plain text', () => {
    expect(langFromPath('go.sum')).toBe('plaintext');
    expect(langFromPath('x/go.work.sum')).toBe('plaintext');
  });

  it('matches by filename only — other .mod files and vendor manifests are unchanged', () => {
    expect(langFromPath('foo.mod')).toBe('plaintext');
    expect(langFromPath('vendor/modules.txt')).toBe('plaintext');
    expect(langFromPath('main.go')).toBe('go');
  });
});

describe('languageDisplayName', () => {
  it('names the languages the nav message speaks about', () => {
    expect(languageDisplayName('go')).toBe('Go');
    expect(languageDisplayName('gomod')).toBe('Go module');
    expect(languageDisplayName('python')).toBe('Python');
    expect(languageDisplayName('csharp')).toBe('C#');
    expect(languageDisplayName('bat')).toBe('Batch');
    expect(languageDisplayName('ini')).toBe('INI');
  });

  it('has no name for plain text or an id the app never produces', () => {
    expect(languageDisplayName('plaintext')).toBeNull();
    expect(languageDisplayName('klingon')).toBeNull();
  });

  it('names every language id langFromPath can return', () => {
    const samples = [
      'a.ts',
      'a.js',
      'a.json',
      'a.md',
      'a.mdx',
      'a.css',
      'a.scss',
      'a.less',
      'a.html',
      'a.py',
      'a.rs',
      'a.go',
      'a.sh',
      'a.ps1',
      'a.bat',
      'a.yml',
      'a.toml',
      'a.java',
      'a.kt',
      'a.scala',
      'a.c',
      'a.cpp',
      'a.cs',
      'a.fs',
      'a.vb',
      'a.rb',
      'a.php',
      'a.swift',
      'a.dart',
      'a.lua',
      'a.pl',
      'a.r',
      'a.jl',
      'a.clj',
      'a.ex',
      'a.sol',
      'a.tcl',
      'a.pas',
      'a.sql',
      'a.graphql',
      'a.proto',
      'a.tf',
      'Dockerfile',
      'a.xml',
      'go.mod',
      '.bashrc',
      'a.log',
    ];
    for (const s of samples) expect(languageDisplayName(langFromPath(s)), s).toBeTruthy();
  });
});

describe('langFromPath — logs and golden files (spec 2026-10-08-language-support §2.1)', () => {
  it('maps .log and rotated logs to log, whatever the case', () => {
    for (const p of [
      'app.log',
      'UPPER.LOG',
      'dir/app.log.1',
      'App.Log.1',
      'app.log.12',
      'app.log.2026-10-01',
      'app.log.2026-10-01_13',
    ]) {
      expect(langFromPath(p), p).toBe('log');
    }
    expect(languageDisplayName('log')).toBe('Log');
  });

  it('leaves compressed and non-numeric rotations alone', () => {
    expect(langFromPath('app.log.1.gz')).toBe('plaintext');
    expect(langFromPath('app.log.old')).toBe('plaintext');
    expect(langFromPath('app.log.2026-10-01.gz')).toBe('plaintext');
  });

  it('colours a golden file as the language of what it wraps, stripping one suffix', () => {
    expect(langFromPath('expected.json.golden')).toBe('json');
    expect(langFromPath('testdata/README.md.golden')).toBe('markdown');
    expect(langFromPath('OUT.TS.GOLDEN')).toBe('typescript');
    expect(langFromPath('out.txt.golden')).toBe('plaintext');
    expect(langFromPath('x.golden')).toBe('plaintext');
    expect(langFromPath('a.golden.golden')).toBe('plaintext');
    expect(langFromPath('go.mod.golden')).toBe('gomod');
    expect(langFromPath('server.log.golden')).toBe('log');
    expect(langFromPath('app.log.1.golden')).toBe('log');
  });

  it('recognises golden paths by name only', () => {
    expect(isGoldenPath('a/expected.json.golden')).toBe(true);
    expect(isGoldenPath('C:\\x\\plain.GOLDEN')).toBe(true);
    expect(isGoldenPath('golden/app.json')).toBe(false);
    expect(isGoldenPath('notgolden')).toBe(false);
  });
});
