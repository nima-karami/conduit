import { describe, expect, it } from 'vitest';
import {
  isGoldenPath,
  langFromPath,
  langFromPathAndText,
  langFromShebang,
  languageDisplayName,
  SHEBANG_SNIFF_CHARS,
} from '../../src/lang';

// Spec 2026-10-08-language-coverage §2.2 table, row by row: [id, extensions, exact filenames].
const SPEC_2_2: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ['python', ['pyi', 'pyw'], []],
  ['cpp', ['hxx', 'ipp', 'inl', 'tpp', 'cu', 'cuh', 'ino'], []],
  ['objective-c', ['mm'], []],
  ['csharp', ['csx', 'cake'], []],
  ['razor', ['cshtml', 'razor'], []],
  ['fsharp', ['fsi', 'fsscript'], []],
  ['ocaml', ['ml', 'mli'], []],
  [
    'ruby',
    ['rake', 'gemspec', 'ru', 'rbw'],
    [
      'gemfile',
      'rakefile',
      'podfile',
      'vagrantfile',
      'brewfile',
      'guardfile',
      'fastfile',
      'appfile',
    ],
  ],
  ['powershell', ['psd1'], []],
  ['php', ['phtml'], []],
  ['html', ['xhtml', 'shtml'], []],
  [
    'xml',
    [
      'xsd',
      'xsl',
      'xslt',
      'csproj',
      'fsproj',
      'vbproj',
      'props',
      'targets',
      'config',
      'resx',
      'nuspec',
      'wxs',
    ],
    [],
  ],
  [
    'json',
    ['json5', 'jsonl', 'ndjson'],
    ['.babelrc', '.eslintrc', '.prettierrc', '.swcrc', '.jshintrc'],
  ],
  ['clojure', ['cljc', 'edn'], []],
  ['scala', ['sbt'], []],
  [
    'shell',
    ['ksh', 'mksh'],
    ['.profile', '.zprofile', '.zshenv', '.bash_aliases', '.bash_logout', '.envrc', 'pkgbuild'],
  ],
  ['ini', ['ini'], ['.gitconfig', '.editorconfig', '.npmrc', '.gitattributes', 'tox.ini']],
  ['toml', ['toml'], ['cargo.lock', 'poetry.lock', 'uv.lock', 'pipfile']],
  ['makefile', ['mk', 'mak'], ['makefile', 'gnumakefile', 'makefile.am', 'makefile.in']],
  ['cmake', ['cmake'], ['cmakelists.txt']],
  ['diff', ['diff', 'patch', 'rej'], []],
  [
    'ignore',
    [],
    [
      '.gitignore',
      '.dockerignore',
      '.npmignore',
      '.prettierignore',
      '.eslintignore',
      '.gcloudignore',
      '.vscodeignore',
    ],
  ],
  ['dotenv', ['env'], []],
  ['groovy', ['groovy', 'gradle', 'gvy'], ['jenkinsfile']],
  ['coffeescript', ['coffee'], []],
  ['handlebars', ['hbs', 'handlebars'], []],
  ['twig', ['twig'], []],
  ['pug', ['pug', 'jade'], []],
  ['liquid', ['liquid'], []],
  ['bicep', ['bicep'], []],
  ['wgsl', ['wgsl'], []],
  ['scheme', ['scm', 'ss', 'rkt'], []],
  ['restructuredtext', ['rst'], []],
  ['systemverilog', ['sv', 'svh'], []],
  ['verilog', ['v', 'vh'], []],
  ['typespec', ['tsp'], []],
  ['cypher', ['cypher', 'cyp'], []],
  ['powerquery', ['pq', 'pqm'], []],
  ['qsharp', ['qs'], []],
  ['sparql', ['rq'], []],
  ['dart', ['dart'], []],
];

describe('langFromPath — spec 2026-10-08-language-coverage §2.2', () => {
  it('resolves every §2.2 name', () => {
    for (const [id, exts, names] of SPEC_2_2) {
      for (const ext of exts) {
        expect(langFromPath(`dir/a.${ext}`), ext).toBe(id);
        expect(langFromPath(`DIR\\A.${ext.toUpperCase()}`), ext).toBe(id);
      }
      for (const name of names) {
        expect(langFromPath(`repo/${name}`), name).toBe(id);
        expect(langFromPath(name.toUpperCase()), name).toBe(id);
      }
      expect(languageDisplayName(id), id).toBeTruthy();
    }
  });

  it('runs prefix rules only when the extension is not in the table', () => {
    expect(langFromPath('Makefile.toml')).toBe('toml');
    expect(langFromPath('.env.json')).toBe('json');
    expect(langFromPath('Dockerfile.dev')).toBe('dockerfile');
    expect(langFromPath('dev.Dockerfile')).toBe('dockerfile');
    expect(langFromPath('Containerfile.prod')).toBe('dockerfile');
    expect(langFromPath('dockerfile.json')).toBe('json');
    for (const p of ['.env', '.env.local', '.env.production', 'app/.env.example']) {
      expect(langFromPath(p), p).toBe('dotenv');
    }
    expect(langFromPath('.envrc')).toBe('shell');
    expect(langFromPath('x.env')).toBe('dotenv');
  });

  it('keeps the §4 edge rows', () => {
    expect(langFromPath('x.m')).toBe('plaintext');
    expect(langFromPath('CMakeLists.TXT')).toBe('cmake');
    expect(langFromPath('MAKEFILE')).toBe('makefile');
    expect(langFromPath('X.TOML')).toBe('toml');
    expect(langFromPath('x.cmake')).toBe('cmake');
    expect(langFromPath('x.mk')).toBe('makefile');
    expect(langFromPath('Makefile.am')).toBe('makefile');
    expect(langFromPath('x.d.ts')).toBe('typescript');
    expect(langFromPath('foo.test.tsx')).toBe('typescript');
    expect(langFromPath('docker-compose.override.yml')).toBe('yaml');
    expect(langFromPath('go.sum')).toBe('plaintext');
    expect(langFromPath('LICENSE')).toBe('plaintext');
    expect(langFromPath('a.vue')).toBe('html');
    expect(langFromPath('a.svelte')).toBe('html');
    expect(langFromPath('a.h')).toBe('c');
    expect(langFromPath('Cargo.lock.golden')).toBe('toml');
  });
});

describe('langFromShebang — spec §2.4', () => {
  it('maps interpreters, through env and its flags', () => {
    const cases: Array<[string, string | null]> = [
      ['#!/usr/bin/env python3', 'python'],
      ['#!/usr/bin/env -S deno run -A', 'typescript'],
      ['\uFEFF#!/bin/bash\r', 'shell'],
      ['#!/usr/bin/env NAME=v python3.12', 'python'],
      ['#!/usr/bin/env -u X ruby', 'ruby'],
      ['#! /usr/bin/env  pwsh-preview', 'powershell'],
      ['#!/usr/bin/env uvx', 'python'],
      ['#!/usr/bin/make -f', 'makefile'],
      ['#!/opt/x/unknown', null],
      ['no shebang', null],
      ['', null],
      ['#!', null],
      ['#!/usr/bin/env', null],
      ['#!/usr/bin/env -i -- node', 'javascript'],
      ['#!/usr/local/bin/node --harmony', 'javascript'],
      ['#!/usr/bin/env bun', 'javascript'],
      ['#!/usr/bin/env ts-node', 'typescript'],
      ['#!/usr/bin/env tsx', 'typescript'],
      ['#!/bin/sh', 'shell'],
      ['#!/usr/bin/fish', 'shell'],
      ['#!/usr/bin/perl -w', 'perl'],
      ['#!/usr/bin/env php', 'php'],
      ['#!/usr/bin/env luajit', 'lua'],
      ['#!/usr/bin/env Rscript', 'r'],
      ['#!/usr/bin/env julia', 'julia'],
      ['#!/usr/bin/env elixir', 'elixir'],
      ['#!/usr/bin/tclsh8.6', 'tcl'],
      ['#!/usr/bin/env wish', 'tcl'],
      ['#!/usr/bin/pypy3', 'python'],
      ['#!/usr/bin/python2.7', 'python'],
    ];
    for (const [line, want] of cases) expect(langFromShebang(line), line).toBe(want);
  });
});

describe('langFromPathAndText — spec §2.2 step 5', () => {
  it('sniffs only a plaintext name with no exact-filename entry', () => {
    expect(langFromPathAndText('bin/py', '#!/usr/bin/env python3\nprint(1)\n')).toBe('python');
    expect(langFromPathAndText('go.sum', '#!/usr/bin/env python3')).toBe('plaintext');
    expect(langFromPathAndText('run.golden', '#!/bin/sh')).toBe('shell');
    expect(langFromPathAndText('a.ts', '#!/usr/bin/env python3')).toBe('typescript');
    expect(langFromPathAndText('LICENSE', 'MIT License\n')).toBe('plaintext');
    expect(langFromPathAndText('tool', '\uFEFF#!/bin/bash\r\necho\r\n')).toBe('shell');
  });

  it('reads the first line only within SHEBANG_SNIFF_CHARS', () => {
    expect(SHEBANG_SNIFF_CHARS).toBe(256);
    const padded = `#!/usr/bin/env ${' '.repeat(300)}python3\n`;
    expect(langFromPathAndText('tool', padded)).toBe('plaintext');
    expect(langFromPathAndText('tool', `#!/bin/sh${' '.repeat(240)}\n`)).toBe('shell');
    expect(langFromPathAndText('tool', '\n#!/usr/bin/env python3')).toBe('plaintext');
  });
});

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
      'Makefile',
      'CMakeLists.txt',
      'a.diff',
      '.gitignore',
      '.env',
      'a.groovy',
      'a.ml',
      'a.mm',
      'a.razor',
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
