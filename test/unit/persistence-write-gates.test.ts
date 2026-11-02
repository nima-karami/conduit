import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScrollbackWriteGate } from '../../src/persistence-write-gates';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-write-gates-'));
  dirs.push(dir);
  return dir;
}

const readIn = (dir: string) => (name: string) => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return undefined;
  }
};

describe('persisted write gates', () => {
  it('a newer scrollback file is neither replayed, persisted over nor deleted', () => {
    const dir = scratchDir();
    const newer = JSON.stringify({ version: 3, sessionId: 's1', segments: [] });
    fs.writeFileSync(path.join(dir, 'scrollback-s1.json'), newer);
    const gate = new ScrollbackWriteGate(readIn(dir));

    expect(gate.restore('scrollback-s1.json')).toBeNull();
    gate.run('scrollback-s1.json', () =>
      fs.writeFileSync(path.join(dir, 'scrollback-s1.json'), 'x'),
    );
    gate.run('scrollback-s1.json', () => fs.rmSync(path.join(dir, 'scrollback-s1.json')));

    expect(fs.readFileSync(path.join(dir, 'scrollback-s1.json'), 'utf8')).toBe(newer);
  });

  it('judges a file on first touch, so an unreplayed newer orphan survives the sweep', () => {
    const dir = scratchDir();
    const newer = JSON.stringify({ version: 3, sessionId: 'gone', segments: [] });
    fs.writeFileSync(path.join(dir, 'scrollback-gone.json'), newer);
    fs.writeFileSync(
      path.join(dir, 'scrollback-old.json'),
      JSON.stringify({ version: 2, sessionId: 'old', segments: [] }),
    );
    const gate = new ScrollbackWriteGate(readIn(dir));

    gate.run('scrollback-gone.json', () => fs.rmSync(path.join(dir, 'scrollback-gone.json')));
    gate.run('scrollback-old.json', () => fs.rmSync(path.join(dir, 'scrollback-old.json')));

    expect(fs.existsSync(path.join(dir, 'scrollback-gone.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'scrollback-old.json'))).toBe(false);
  });

  it('a file this run wrote is not re-read before the next persist', () => {
    const dir = scratchDir();
    const reads: string[] = [];
    const gate = new ScrollbackWriteGate((name) => {
      reads.push(name);
      return readIn(dir)(name);
    });
    let writes = 0;
    gate.run('scrollback-s1.json', () => writes++);
    gate.run('scrollback-s1.json', () => writes++);
    expect(writes).toBe(2);
    expect(reads).toEqual(['scrollback-s1.json']);
  });
});
