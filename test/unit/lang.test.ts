import { describe, expect, it } from 'vitest';
import { langFromPath, languageDisplayName } from '../../src/lang';

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
    ];
    for (const s of samples) expect(languageDisplayName(langFromPath(s)), s).toBeTruthy();
  });
});
