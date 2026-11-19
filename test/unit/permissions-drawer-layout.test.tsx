// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { PermissionsDrawer } from '../../webview/components/permissions-drawer';

/**
 * CON-71: scrolling the MCP drawer scrolled the whole tab (list, drawer and all), because the
 * panel was the only scroll container. jsdom has no layout, so the height chain that makes the
 * list and the drawer body their own scrollers is pinned here at the stylesheet. The real wheel
 * is exercised by the `permissions-drawer` e2e.
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

  it('places the floating stack beside the measured drawer column', () => {
    expect(rule('.toasts').right).toBe('calc(var(--toast-side, 0px) + var(--toast-inset))');
  });
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it.each([false, true])('reserves the actual drawer column with footer=%s', async (hasFooter) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const measure = Element.prototype.getBoundingClientRect;
  let distance = 440;
  Element.prototype.getBoundingClientRect = () =>
    ({ left: window.innerWidth - distance }) as DOMRect;
  const style = document.documentElement.style;
  try {
    await act(async () =>
      root.render(
        <PermissionsDrawer
          title="First"
          closeLabel="Close"
          closeGlyph="✕"
          onClose={() => {}}
          footer={hasFooter ? <button type="button">Review</button> : undefined}
        >
          <p>Drawer body</p>
        </PermissionsDrawer>,
      ),
    );
    expect(style.getPropertyValue('--toast-side')).toBe('440px');
    distance = 460;
    window.dispatchEvent(new Event('resize'));
    expect(style.getPropertyValue('--toast-side')).toBe('460px');
    await act(async () => root.render(null));
    expect(style.getPropertyValue('--toast-side')).toBe('');
  } finally {
    Element.prototype.getBoundingClientRect = measure;
    await act(async () => root.unmount());
    host.remove();
  }
});
