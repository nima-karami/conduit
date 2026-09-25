// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { CustomShaderEditor } from '../../webview/components/settings-modal';
import { installUnclaimedDropGuard } from '../../webview/unclaimed-drop-guard';

// The guard stamps dropEffect 'none' on every Files dragover, so a Files drop target claims the
// drag only by setting its own dropEffect (os-drag-out spec §2.2). Every file with a dragover
// handler is listed here with how it satisfies that; a new one fails until someone checks it.
const AUDITED: Record<string, string> = {
  'webview/app.tsx': 'dock: acts only on its own panel drag, never Files',
  'webview/components/board-view.tsx': 'acts only on its own card drag',
  'webview/components/center-pane.tsx': 'dock handlers from app.tsx',
  'webview/components/doc-tabs.tsx': 'acts only on its own tab drag',
  'webview/components/files-view.tsx': 'scroller sets dropEffect; + Add folder only stops it',
  'webview/components/folder-section.tsx': 'rows and sections set dropEffect',
  'webview/components/panel-frame.tsx': 'dock handlers from app.tsx',
  'webview/components/project-group-header.tsx': 'sidebar handlers, own drags only',
  'webview/components/session-card.tsx': 'sidebar handlers, own drags only',
  'webview/components/settings-modal.tsx': 'shader textarea sets dropEffect (tested below)',
  'webview/components/sidebar.tsx': 'acts only on its own card/group drags',
  'webview/components/terminal-pane.tsx': 'onPathDragOver sets dropEffect',
};

function filesWithDragOver(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesWithDragOver(p));
    else if (/\.tsx?$/.test(e.name) && /onDragOver|'dragover'/.test(fs.readFileSync(p, 'utf8')))
      out.push(path.relative(process.cwd(), p).split(path.sep).join('/'));
  }
  return out;
}

describe('Files drop targets claim the drag', () => {
  it('every dragover handler is audited against the claim rule', () => {
    const found = filesWithDragOver('webview').filter(
      (f) => f !== 'webview/unclaimed-drop-guard.ts',
    );
    expect(found.sort()).toEqual(Object.keys(AUDITED).sort());
  });
});

let host: HTMLDivElement;
let root: Root | null = null;
let uninstall: () => void = () => {};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  uninstall = installUnclaimedDropGuard(window);
});
afterEach(async () => {
  uninstall();
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
});

function filesDragOver(target: Element) {
  const ev = new Event('dragover', { bubbles: true, cancelable: true });
  const dataTransfer = { types: ['Files'], dropEffect: 'copy', files: [] };
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, effect: dataTransfer.dropEffect };
}

describe('Custom shader textarea', () => {
  it('claims a Files drag with the guard installed', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(CustomShaderEditor, { settings: DEFAULT_SETTINGS, update: () => {} }),
      );
    });
    const ta = host.querySelector('textarea');
    if (!ta) throw new Error('no textarea');
    expect(filesDragOver(ta)).toEqual({ prevented: true, effect: 'copy' });
  });
});
