import { describe, expect, it } from 'vitest';
import { resolveTitleSync } from '../../src/session-title';

const base = { name: 'conduit', projectPath: 'C:\\dev\\conduit' };

describe('resolveTitleSync', () => {
  it('adopts a meaningful app title', () => {
    expect(resolveTitleSync(base, 'Claude Code — fixing paste')).toBe('Claude Code — fixing paste');
  });

  it('ignores empty/whitespace titles', () => {
    expect(resolveTitleSync(base, '')).toBeNull();
    expect(resolveTitleSync(base, '   ')).toBeNull();
  });

  it('lets a meaningful title (CLI /rename) override any current name', () => {
    // Even if the name was set by a prior manual rename, a real title still wins.
    expect(resolveTitleSync({ ...base, name: 'My manual name' }, 'RenamedViaCli')).toBe(
      'RenamedViaCli',
    );
  });

  it('ignores cwd-path titles (Windows drive, unix root, nested)', () => {
    expect(resolveTitleSync(base, 'C:\\dev\\conduit')).toBeNull();
    expect(resolveTitleSync(base, '/home/me/proj')).toBeNull();
    expect(resolveTitleSync(base, 'Users\\me\\proj')).toBeNull();
  });

  it('ignores the project folder name itself', () => {
    expect(resolveTitleSync(base, 'conduit')).toBeNull();
    expect(resolveTitleSync(base, 'CONDUIT')).toBeNull();
  });

  it('ignores a no-op (title already equals the name) and overlong titles', () => {
    expect(resolveTitleSync({ ...base, name: 'X' }, 'X')).toBeNull();
    expect(resolveTitleSync(base, 'a'.repeat(81))).toBeNull();
  });

  it('adopts another recognizable app title', () => {
    expect(resolveTitleSync({ name: 'conduit', projectPath: 'C:\\dev\\conduit' }, 'Aider')).toBe(
      'Aider',
    );
  });

  it('ignores tool/command titles a shell or runner sets while a command runs', () => {
    // npm/yarn/pnpm set the terminal title to the running script; that is NOT a
    // session name. (This is the user-reported "npm run security" rename bug.)
    expect(resolveTitleSync(base, 'npm run security')).toBeNull();
    expect(resolveTitleSync(base, 'npm install')).toBeNull();
    expect(resolveTitleSync(base, 'yarn build')).toBeNull();
    expect(resolveTitleSync(base, 'pnpm run verify')).toBeNull();
    expect(resolveTitleSync(base, 'npx playwright test')).toBeNull();
    expect(resolveTitleSync(base, 'git commit -m wip')).toBeNull();
    expect(resolveTitleSync(base, 'node esbuild.mjs')).toBeNull();
    expect(resolveTitleSync(base, 'python manage.py runserver')).toBeNull();
    expect(resolveTitleSync(base, 'cargo build')).toBeNull();
    expect(resolveTitleSync(base, 'docker compose up')).toBeNull();
  });

  it('matches the command name case-insensitively and tolerates a .exe suffix', () => {
    expect(resolveTitleSync(base, 'NPM run build')).toBeNull();
    expect(resolveTitleSync(base, 'node.exe server.js')).toBeNull();
  });

  it('still adopts a genuine title whose first word merely starts like a command', () => {
    // "nodemon" is a command, but "Node project" is a fine name; only an exact
    // first-token command match is rejected, not a prefix.
    expect(resolveTitleSync(base, 'Node project dashboard')).toBe('Node project dashboard');
    expect(resolveTitleSync(base, 'Goose agent')).toBe('Goose agent');
  });
});
