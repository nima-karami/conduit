import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchRow, orderBranches } from '../../src/branch-menu';

describe('orderBranches', () => {
  it('pins the current branch first', () => {
    expect(orderBranches(['dev', 'main', 'release'], 'main')).toEqual(['main', 'dev', 'release']);
  });

  it('leaves the list alone when there is no current branch (detached HEAD)', () => {
    expect(orderBranches(['dev', 'main'], null)).toEqual(['dev', 'main']);
  });

  it('does not duplicate a current branch that is missing from the list', () => {
    expect(orderBranches(['dev'], 'main')).toEqual(['main', 'dev']);
  });
});

describe('branchRow', () => {
  it('marks the current branch non-actionable but NOT disabled', () => {
    const row = branchRow('main', 'main', false);
    expect(row).toEqual({ branch: 'main', current: true, actionable: false, disabled: false });
  });

  // The regression this file exists for: the current branch shipped as `disabled`, so the
  // one row the menu exists to confirm was painted with the disabled opacity — the faintest
  // thing in the menu. Non-actionable is a state; unavailable is a different one.
  it('never disables a row for being current, only for the menu being busy', () => {
    expect(branchRow('main', 'main', false).disabled).toBe(false);
    expect(branchRow('main', 'main', true).disabled).toBe(branchRow('dev', 'main', true).disabled);
  });

  it('makes every other branch actionable', () => {
    expect(branchRow('dev', 'main', false)).toEqual({
      branch: 'dev',
      current: false,
      actionable: true,
      disabled: false,
    });
  });

  it('disables the whole menu mid-switch', () => {
    const row = branchRow('dev', 'main', true);
    expect(row.disabled).toBe(true);
    expect(row.actionable).toBe(false);
  });

  it('treats a detached HEAD as having no current row', () => {
    expect(branchRow('main', null, false).current).toBe(false);
  });
});

// The derivation above is only worth anything if the menu actually routes through it — the
// inversion came back the moment `disabled` was computed inline at the JSX. There is no DOM
// in this suite (vitest runs on `node`), so the binding is checked at the source.
describe('the branch menu binds its row states to the derivation', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', 'webview', 'components', 'branch-switcher-menu.tsx'),
    'utf8',
  );

  it('takes `disabled` from branchRow and nothing else', () => {
    expect(SRC).toContain('disabled={row.disabled}');
    // Lookbehind so the aria-disabled binding below, which SHOULD read `current`, is exempt.
    expect(SRC).not.toMatch(/(?<!-)disabled=\{[^}]*[Cc]urrent/);
  });

  it('marks the current row with aria, not by disabling it', () => {
    expect(SRC).toContain('aria-checked={row.current}');
    expect(SRC).toContain('aria-disabled={row.current || undefined}');
  });
});
