import { describe, expect, it } from 'vitest';
import type { AgentScopeReason } from '../../src/add-dir-delivery';
import type { AgentScopeView } from '../../src/types';
import {
  ADD_DIR_BUSY_TITLE,
  agentScopeToast,
  asHomeFailedToast,
  asHomeLabel,
  bannerActions,
  bannerCopy,
  type CopySegment,
  MISSING_HOME_TITLE,
  RESTART_CONFIRM,
} from '../../webview/agent-scope-copy';

const join = (s: CopySegment[] | undefined) => (s ?? []).map((x) => x.text).join('');
const view = (unseen: string[], stillSeen: string[] = [], typeable = unseen): AgentScopeView => ({
  unseen,
  stillSeen,
  typeable,
});

describe('bannerCopy (AC-5)', () => {
  it('1 unseen', () => {
    const c = bannerCopy(view(['C:\\w\\D with space']));
    expect(join(c.segments)).toBe("claude can't see D with space yet");
    expect(c.segments.filter((s) => s.kind === 'name').map((s) => s.text)).toEqual([
      'D with space',
    ]);
    expect(c.second).toBeUndefined();
  });

  it('2 unseen', () => {
    expect(join(bannerCopy(view(['/x/a', '/x/b'])).segments)).toBe("claude can't see a and b yet");
  });

  it('3+ unseen', () => {
    expect(join(bannerCopy(view(['/x/a', '/x/b', '/x/c'])).segments)).toBe(
      "claude can't see a and 2 more folders yet",
    );
    expect(join(bannerCopy(view(['/x/a', '/x/b', '/x/c', '/x/d'])).segments)).toBe(
      "claude can't see a and 3 more folders yet",
    );
  });

  it('stillSeen only (1 and 2)', () => {
    expect(join(bannerCopy(view([], ['/x/old'])).segments)).toBe(
      'claude can still see old until it restarts',
    );
    expect(join(bannerCopy(view([], ['/x/old', '/x/older'])).segments)).toBe(
      'claude can still see old and 1 more folder until it restarts',
    );
  });

  it('both → a second line', () => {
    const c = bannerCopy(view(['/x/new'], ['/x/old']));
    expect(join(c.segments)).toBe("claude can't see new yet");
    expect(join(c.second)).toBe('It can still see old until it restarts.');
  });

  it('title lists every full path', () => {
    expect(bannerCopy(view(['/x/a', '/x/b', '/x/c'], ['/y/d'])).title).toBe(
      '/x/a\n/x/b\n/x/c\n/y/d',
    );
  });

  it('a pasted folder → "Press Enter in claude to add {a}", other lines unchanged', () => {
    const c = bannerCopy({ ...view(['/x/a', '/x/b'], ['/x/old']), pasted: '/x/b' });
    expect(join(c.segments)).toBe('Press Enter in claude to add b');
    expect(c.segments.filter((s) => s.kind === 'name').map((s) => s.text)).toEqual(['b']);
    expect(join(c.second)).toBe('It can still see old until it restarts.');
    expect(c.title).toBe('/x/a\n/x/b\n/x/old');
  });
});

describe('bannerActions', () => {
  const idle = { busy: false, homeMissing: false };

  it('typeable unseen → Run /add-dir primary, Restart secondary', () => {
    expect(bannerActions(view(['/a']), idle)).toEqual({
      showAddDir: true,
      addDirDisabled: false,
      showRestart: true,
      primary: 'addDir',
    });
  });

  it('none typeable → Restart primary, no Add', () => {
    expect(bannerActions(view(['//srv/s'], [], []), idle)).toMatchObject({
      showAddDir: false,
      showRestart: true,
      primary: 'restart',
    });
  });

  it('stillSeen only → Restart primary, no Add', () => {
    expect(bannerActions(view([], ['/old']), idle)).toMatchObject({
      showAddDir: false,
      primary: 'restart',
    });
  });

  it('busy → addDirDisabled', () => {
    expect(bannerActions(view(['/a']), { busy: true, homeMissing: false }).addDirDisabled).toBe(
      true,
    );
  });

  it('homeMissing → no Restart, primary never restart', () => {
    const h = { busy: false, homeMissing: true };
    expect(bannerActions(view([], ['/old']), h)).toMatchObject({
      showRestart: false,
      primary: null,
    });
    expect(bannerActions(view(['/a']), h)).toMatchObject({ showRestart: false, primary: 'addDir' });
  });
});

describe('agentScopeToast (spec §3.3)', () => {
  it('maps all seven reasons', () => {
    const all: Record<AgentScopeReason, string | null> = {
      busy: ADD_DIR_BUSY_TITLE,
      writeFailed: "Couldn't type /add-dir — claude isn't running",
      notRunning: "Couldn't type /add-dir — claude isn't running",
      notClaude: null,
      homeMissing: null,
      noSession: null,
      nothingPending: null,
    };
    for (const [reason, copy] of Object.entries(all)) {
      expect(agentScopeToast(reason as AgentScopeReason), reason).toBe(copy);
    }
    expect(ADD_DIR_BUSY_TITLE).toBe("claude is working — try again when it's idle");
  });
});

describe('centre + confirm copy', () => {
  it('fixed strings', () => {
    expect(RESTART_CONFIRM).toBe('Restart claude? This conversation ends.');
    expect(MISSING_HOME_TITLE).toBe('Home folder not found');
    expect(asHomeLabel('E')).toBe('Use E as home');
    expect(asHomeFailedToast('E')).toBe("Couldn't make E the home folder");
  });
});
