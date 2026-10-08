/**
 * The C/C++ fixture (docs/plans/2026-10-08-language-coverage.plan.md Task B5.1): `main.cpp` calling
 * into `greet.hpp`/`greet.cpp` and a `.h` header, with a compile_commands.json of absolute paths.
 * No standard header is included, so no toolchain's headers are needed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverInstalled } from './lsp-fixture.mjs';

/** `greet(2)` in main.cpp, 0-based for `lsp:request`. */
export const CPP_GREET_CALL = { line: 4, character: '    return '.length };

/** The runner's LLVM is found through %ProgramFiles%, as the host finds it; PATH is the fallback. */
export function clangdInstalled() {
  const fixed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'LLVM', 'bin', 'clangd.exe');
  return (
    (existsSync(fixed) && serverInstalled(fixed, ['--version'])) ||
    serverInstalled('clangd', ['--version'])
  );
}

export function writeClangdFixture(dir) {
  mkdirSync(dir, { recursive: true });
  const files = {
    main: join(dir, 'main.cpp'),
    hpp: join(dir, 'greet.hpp'),
    cpp: join(dir, 'greet.cpp'),
    header: join(dir, 'util.h'),
  };
  writeFileSync(
    files.main,
    '#include "greet.hpp"\n#include "util.h"\n\nint main() {\n    return greet(2) + twice(1);\n}\n',
  );
  writeFileSync(files.hpp, '#pragma once\n\n/// Doubles n.\nint greet(int n);\n');
  writeFileSync(files.cpp, '#include "greet.hpp"\n\nint greet(int n) { return n * 2; }\n');
  writeFileSync(files.header, '#pragma once\n\nstatic inline int twice(int n) { return n + n; }\n');
  const entry = (file) => ({
    directory: dir,
    file,
    arguments: ['clang++', '-std=c++17', '-c', file],
  });
  writeFileSync(
    join(dir, 'compile_commands.json'),
    `${JSON.stringify([entry(files.main), entry(files.cpp)], null, 2)}\n`,
  );
  return files;
}
