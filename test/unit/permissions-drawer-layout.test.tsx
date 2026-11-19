// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { toastFloorPx, useToastFloor } from '../../webview/toast-floor';

/**
 * CON-71: scrolling the MCP drawer scrolled the whole tab (list, drawer and all), because the
 * panel was the only scroll container. jsdom has no layout, so the height chain that makes the
 * list and the drawer body their own scrollers is pinned here at the stylesheet. The real wheel
 * is exercised by the `permissions-drawer-scroll` e2e.
 */
const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Declarations of the first top-level rule whose selector list is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    match[1]
      .split(';')
      .map((d) => d.split(':').map((part) => part.trim()))
      .filter(([prop, value]) => prop && value)
      .map(([prop, ...value]) => [prop, value.join(':')]),
  );
}

describe('MCP drawer height chain', () => {
  it('lays the Roles/Agents panel out as a column the split fills', () => {
    expect(rule('.mcp-section__panel--split')).toMatchObject({
      display: 'flex',
      'flex-direction': 'column',
    });
    expect(rule('.permissions-roles')).toMatchObject({ flex: '1 1 0', 'min-height': '0' });
  });

  it('lets the list scroll on its own', () => {
    expect(
      rule('.permissions-roles > :is(.permissions-role-list, .permissions-agents-list)'),
    ).toMatchObject({ overflow: 'auto', 'min-height': '0' });
  });

  it('scrolls only the drawer body; header and footer stay', () => {
    expect(rule('.permissions-roles__side')).toMatchObject({
      display: 'flex',
      'flex-direction': 'column',
      'min-height': '0',
    });
    expect(rule('.permissions-drawer')).toMatchObject({ 'min-height': '0', display: 'flex' });
    expect(rule('.permissions-drawer__body')).toMatchObject({
      'overflow-y': 'auto',
      'min-height': '0',
    });
    expect(rule('.permissions-drawer__foot')).toMatchObject({ flex: '0 0 auto' });
    expect(rule('.permissions-drawer__head').overflow).toBeUndefined();
  });

  it('raises the floating stack by the measured drawer footer floor', () => {
    expect(rule('.toasts').bottom).toBe('calc(var(--toast-floor, 0px) + var(--toast-inset))');
  });
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function Footer({ active }: { active: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useToastFloor(ref, active);
  return <footer ref={ref} />;
}

describe('useToastFloor', () => {
  it('sets --toast-floor to the distance from the footer top to the window bottom, then clears it', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const top = window.innerHeight - 60;
    const spy = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () =>
      ({ top, bottom: top + 60, left: 0, right: 0, width: 0, height: 60, x: 0, y: top }) as DOMRect;
    try {
      await act(async () => root.render(<Footer active />));
      expect(toastFloorPx()).toBe(60);
      expect(document.documentElement.style.getPropertyValue('--toast-floor')).toBe('60px');
      await act(async () => root.render(<Footer active={false} />));
      expect(toastFloorPx()).toBe(0);
      expect(document.documentElement.style.getPropertyValue('--toast-floor')).toBe('');
    } finally {
      Element.prototype.getBoundingClientRect = spy;
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
