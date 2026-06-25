import { describe, expect, it } from 'vitest';
import { fileIconColor, fileIconKind } from '../../src/file-icon';

describe('fileIconKind', () => {
  it('maps code extensions to the code kind', () => {
    for (const f of ['a.ts', 'b.tsx', 'c.go', 'd.rs', 'e.py', 'f.java', 'g.cpp']) {
      expect(fileIconKind(f)).toBe('code');
    }
  });

  it('maps structured-data, markdown, style, web, image, shell, config kinds', () => {
    expect(fileIconKind('package.json')).toBe('json');
    expect(fileIconKind('conf.yaml')).toBe('json');
    expect(fileIconKind('README.md')).toBe('markdown');
    expect(fileIconKind('styles.scss')).toBe('style');
    expect(fileIconKind('index.html')).toBe('web');
    expect(fileIconKind('logo.png')).toBe('image');
    expect(fileIconKind('run.sh')).toBe('shell');
    expect(fileIconKind('settings.ini')).toBe('config');
    expect(fileIconKind('yarn.lock')).toBe('lock');
  });

  it('recognizes fixed-name files without an extension', () => {
    expect(fileIconKind('repo/Dockerfile')).toBe('config');
    expect(fileIconKind('.gitignore')).toBe('config');
    expect(fileIconKind('.bashrc')).toBe('shell');
  });

  it('falls back to generic for unknown extensions', () => {
    expect(fileIconKind('mystery.qwerty')).toBe('generic');
    expect(fileIconKind('noext')).toBe('generic');
  });
});

describe('fileIconColor', () => {
  it('uses a per-extension accent where defined', () => {
    expect(fileIconColor('app.ts')).toBe('#3178c6');
    expect(fileIconColor('main.go')).toBe('#00add8');
  });

  it('falls back to the kind colour for extensions without a specific accent', () => {
    // .rb has no per-ext entry here? it does — use one that doesn't: .lua → code kind colour
    expect(fileIconColor('script.lua')).toBe(fileIconColor('other.scala'));
    expect(fileIconColor('mystery.qwerty')).toBe('#8a8f98'); // generic kind colour
  });
});
