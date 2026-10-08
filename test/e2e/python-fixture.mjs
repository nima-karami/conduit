/**
 * The Python fixture (docs/plans/2026-10-08-language-coverage.plan.md Task B5.1). The marker lives
 * in `app/`, so `loose/` sits under the workspace with no marker — the ad-hoc root case.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `greet("x")` in app/main.py, 0-based for `lsp:request`. */
export const PY_GREET_CALL = { line: 4, character: '    return '.length };
/** `local_helper()` in loose/solo.py. */
export const PY_SOLO_CALL = { line: 4, character: 'value = '.length };

export function writePythonFixture(dir) {
  const app = join(dir, 'app');
  mkdirSync(join(app, 'lib'), { recursive: true });
  mkdirSync(join(app, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'loose'), { recursive: true });
  writeFileSync(join(app, 'pyproject.toml'), '[project]\nname = "fix"\nversion = "0.1.0"\n');
  writeFileSync(
    join(app, 'main.py'),
    'from lib.util import greet\n\n\ndef run() -> str:\n    return greet("x")\n',
  );
  writeFileSync(join(app, 'lib', '__init__.py'), '');
  writeFileSync(
    join(app, 'lib', 'util.py'),
    'def greet(name: str) -> str:\n    """Says hi."""\n    return "hi " + name\n',
  );
  writeFileSync(
    join(app, 'bin', 'tool'),
    '#!/usr/bin/env python3\nfrom lib.util import greet\n\nprint(greet("tool"))\n',
  );
  writeFileSync(
    join(dir, 'loose', 'solo.py'),
    'def local_helper() -> int:\n    return 1\n\n\nvalue = local_helper()\n',
  );
  return {
    main: join(app, 'main.py'),
    util: join(app, 'lib', 'util.py'),
    tool: join(app, 'bin', 'tool'),
    solo: join(dir, 'loose', 'solo.py'),
  };
}

/** A 3 MB `.py` (opens as a truncated head window) and one that is not valid UTF-8. */
export function writeUnsyncablePython(dir) {
  const big = join(dir, 'big');
  mkdirSync(big, { recursive: true });
  const lines = [];
  for (let i = 0, size = 0; size < 3 * 1024 * 1024; i++) {
    const def = `def f${i}() -> int:\n    return ${i}\n\n\n`;
    lines.push(def);
    size += def.length;
  }
  writeFileSync(join(big, 'huge.py'), `${lines.join('')}value = f1()\n`);
  writeFileSync(
    join(big, 'latin.py'),
    Buffer.concat([
      Buffer.from('def caf() -> str:\n    return "caf'),
      Buffer.from([0xe9]),
      Buffer.from('"\n\n\nvalue = caf()\n'),
    ]),
  );
  return { huge: join(big, 'huge.py'), latin: join(big, 'latin.py') };
}
