// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DirtyCloseCopy, type DirtyFile, dirtyCloseCopy } from '../../src/quit-guard';
import type { SaveKind } from '../../webview/auto-save-policy';
import {
  DirtyCloseDialog,
  type DirtyCloseDialogProps,
} from '../../webview/components/dirty-close-dialog';
import { QuitScrim } from '../../webview/components/quit-scrim';
import type { FileSaveStatus } from '../../webview/file-save-controller';
import { type DirtyAnswer, type DirtyAsk, useDirtyClose } from '../../webview/use-dirty-close';
import { type ModalSlot, nextModalKey, useModalSlot } from '../../webview/use-modal-slot';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement | undefined;
let root: Root | null = null;

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  host = undefined;
});

function mount(): Root {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return root;
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function file(
  path: string,
  tag: DirtyFile['tag'] = null,
  extra: Partial<DirtyFile> = {},
): DirtyFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, dir: 'src', tag, ...extra };
}

function copyOf(files: DirtyFile[], grouped = false): DirtyCloseCopy {
  return dirtyCloseCopy({ files, running: 0, busy: 0, reason: 'quit', grouped });
}

function dialog(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('.confirm');
  if (!el) throw new Error('dialog not rendered');
  return el;
}

function button(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

async function renderDialog(overrides: Partial<DirtyCloseDialogProps> = {}) {
  const props: DirtyCloseDialogProps = {
    copy: copyOf([file('/p/src/a.ts')]),
    phase: 'ready',
    status: null,
    onSaveAll: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const r = mount();
  await act(async () => r.render(createElement(DirtyCloseDialog, props)));
  return {
    props,
    rerender: (next: DirtyCloseDialogProps) =>
      act(async () => r.render(createElement(DirtyCloseDialog, next))),
  };
}

describe('DirtyCloseDialog', () => {
  it('initial focus is Save All', async () => {
    await renderDialog();
    expect(document.activeElement).toBe(button('Save All'));
    expect(button('Save All').hasAttribute('data-modal-default')).toBe(true);
    expect(button('Save All').classList.contains('btn--primary')).toBe(true);
    expect([...dialog().querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cancel',
      "Don't Save",
      'Save All',
    ]);
  });

  it("saving disables Save All and Don't Save, Cancel enabled", async () => {
    const { props } = await renderDialog({ phase: 'saving', status: 'Saving 1 file' });
    expect(button('Saving…').disabled).toBe(true);
    expect(button("Don't Save").disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(false);
    await act(async () => click(button('Cancel')));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onCancel', async () => {
    const { props } = await renderDialog();
    await act(async () => pressEscape());
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(props.onSaveAll).not.toHaveBeenCalled();
  });

  it('rows show dir and tag text; danger class on failed', async () => {
    await renderDialog({
      copy: copyOf([
        file('/p/src/a.ts', 'failed', { error: 'EACCES' }),
        file('/p/src/b.ts', 'conflict'),
        file('/p/src/c.ts'),
      ]),
    });
    const rows = [...dialog().querySelectorAll<HTMLElement>('li.confirm__file')];
    expect(rows).toHaveLength(3);
    expect(rows[0].title).toBe('/p/src/a.ts');
    expect(rows[0].querySelector('.confirm__file-dir')?.textContent).toBe('src');
    const failed = rows[0].querySelector('.confirm__file-tag');
    expect(failed?.textContent).toBe('save failed: EACCES');
    expect(failed?.classList.contains('confirm__file-tag--danger')).toBe(true);
    const conflict = rows[1].querySelector('.confirm__file-tag');
    expect(conflict?.textContent).toBe('changed on disk — Save All overwrites it');
    expect(conflict?.classList.contains('confirm__file-tag--danger')).toBe(false);
    expect(rows[2].querySelector('.confirm__file-tag')).toBeNull();
  });

  it('grouped rows get a group header before each group', async () => {
    await renderDialog({
      copy: copyOf(
        [
          file('/p/a.ts', null, { session: 'one' }),
          file('/p/b.ts', null, { session: 'one' }),
          file('/p/c.ts', null, { session: 'two' }),
        ],
        true,
      ),
    });
    const items = [...dialog().querySelectorAll('ul.confirm__files > li')].map((li) =>
      li.classList.contains('confirm__file-group')
        ? `#${li.textContent}`
        : li.getAttribute('title'),
    );
    expect(items).toEqual(['#one', '/p/a.ts', '/p/b.ts', '#two', '/p/c.ts']);
  });

  it('overflow line', async () => {
    const files = Array.from({ length: 13 }, (_, i) => file(`/p/src/f${i}.ts`));
    await renderDialog({ copy: copyOf(files) });
    expect(dialog().querySelectorAll('li.confirm__file')).toHaveLength(10);
    expect(dialog().textContent).toContain('and 3 more');
  });

  it('no overflow line without overflow', async () => {
    await renderDialog();
    expect(dialog().textContent).not.toContain('more');
  });

  it('onShown once', async () => {
    const onShown = vi.fn();
    const { props, rerender } = await renderDialog({ onShown });
    await rerender({ ...props, phase: 'saving', status: 'Saving 1 file' });
    await rerender({ ...props, phase: 'ready', status: "1 file couldn't be saved" });
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('ul aria-label Unsaved files; status aria-live polite', async () => {
    await renderDialog({ status: 'Saving 1 file' });
    const d = dialog();
    expect(d.getAttribute('role')).toBe('alertdialog');
    expect(d.classList.contains('confirm--files')).toBe(true);
    expect(d.querySelector('ul.confirm__files')?.getAttribute('aria-label')).toBe('Unsaved files');
    const status = d.querySelector('.confirm__status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('Saving 1 file');
    const title = document.getElementById(d.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Do you want to save the changes you made to a.ts?');
    const summary = document.getElementById(d.getAttribute('aria-describedby') ?? '');
    expect(summary?.textContent).toBe("Your changes will be lost if you don't save them.");
  });
});

describe('QuitScrim', () => {
  it('is focused, busy, labelled, and swallows keys', async () => {
    const r = mount();
    await act(async () => r.render(createElement(QuitScrim)));
    const scrim = document.body.querySelector<HTMLElement>('.modal__backdrop .quit-scrim');
    expect(scrim).not.toBeNull();
    expect(document.activeElement).toBe(scrim);
    expect(scrim?.getAttribute('aria-busy')).toBe('true');
    expect(scrim?.getAttribute('aria-label')).toBe('Quitting');
    expect(scrim?.textContent).toBe('Quitting… waiting for another window');
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    const e = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(e);
    document.removeEventListener('keydown', seen);
    expect(e.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
  });
});

// --- the hook -----------------------------------------------------------------------------

interface FakeSaves {
  statuses: Map<string, FileSaveStatus>;
  partial: Set<string>;
  save: ReturnType<typeof vi.fn<(path: string, kind: SaveKind) => Promise<boolean>>>;
  emit(): void;
  listeners: Set<() => void>;
  getStatus(path: string): FileSaveStatus | undefined;
  isPartial(path: string): boolean;
  subscribe(cb: () => void): () => void;
}

function status(phase: FileSaveStatus['phase'], error: string | null = null): FileSaveStatus {
  return { phase, edited: phase !== 'clean', conflict: null, error };
}

function fakeSaves(paths: readonly string[]): FakeSaves {
  const statuses = new Map(paths.map((p) => [p, status('dirty')]));
  const listeners = new Set<() => void>();
  const saves: FakeSaves = {
    statuses,
    partial: new Set(),
    listeners,
    save: vi.fn(async (path: string) => {
      statuses.set(path, status('clean'));
      return true;
    }),
    emit: () => {
      for (const l of [...listeners]) l();
    },
    getStatus: (path) => statuses.get(path),
    isPartial: (path) => saves.partial.has(path),
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return saves;
}

async function mountHook(saves: FakeSaves) {
  let slot: ModalSlot | undefined;
  let api: { ask(req: DirtyAsk): Promise<DirtyAnswer> } | undefined;
  function Harness() {
    const s = useModalSlot();
    slot = s;
    api = useDirtyClose({ saves, rootOf: () => '/p', slot: s });
    const entry = s.current;
    if (entry?.kind === 'dirty') return createElement(DirtyCloseDialog, entry.props);
    if (entry?.kind === 'confirm') return createElement('div', { className: 'fake-confirm' });
    return null;
  }
  const r = mount();
  await act(async () => r.render(createElement(Harness)));
  if (!slot || !api) throw new Error('harness did not mount');
  const s = slot;
  const a = api;
  return {
    slot: s,
    async ask(req: Partial<DirtyAsk> & { paths: readonly string[] }) {
      let answer: Promise<DirtyAnswer> | undefined;
      await act(async () => {
        answer = a.ask({ reason: 'quit', running: 0, busy: 0, ...req });
      });
      if (!answer) throw new Error('ask did not run');
      const settled = vi.fn();
      answer.then(settled);
      return { answer, settled };
    },
  };
}

function rowTags(): (string | null)[] {
  return [...document.body.querySelectorAll('li.confirm__file')].map(
    (li) => li.querySelector('.confirm__file-tag')?.textContent ?? null,
  );
}

describe('useDirtyClose', () => {
  it('Save All all-clean → saved, entry closed', async () => {
    const paths = ['/p/src/a.ts', '/p/src/b.ts'];
    const saves = fakeSaves(paths);
    const h = await mountHook(saves);
    const { answer } = await h.ask({ paths });
    expect(document.body.querySelector('.confirm')).not.toBeNull();
    await act(async () => click(button('Save All')));
    await expect(answer).resolves.toBe('saved');
    expect(saves.save.mock.calls).toEqual([
      ['/p/src/a.ts', 'manual'],
      ['/p/src/b.ts', 'manual'],
    ]);
    expect(h.slot.current).toBeNull();
    expect(document.body.querySelector('.confirm')).toBeNull();
  });

  it('Save All force-writes only a conflict row', async () => {
    const paths = ['/p/src/a.ts', '/p/src/b.ts'];
    const saves = fakeSaves(paths);
    saves.statuses.set('/p/src/b.ts', status('conflict'));
    const h = await mountHook(saves);
    const { answer } = await h.ask({ paths });
    await act(async () => click(button('Save All')));
    await expect(answer).resolves.toBe('saved');
    expect(saves.save.mock.calls).toEqual([
      ['/p/src/a.ts', 'manual'],
      ['/p/src/b.ts', 'force'],
    ]);
  });

  it('Save All partial failure → stays, files cut to unsaved, status "1 file couldn\'t be saved"', async () => {
    const paths = ['/p/src/a.ts', '/p/src/b.ts'];
    const saves = fakeSaves(paths);
    saves.save.mockImplementation(async (path: string) => {
      if (path === '/p/src/b.ts') {
        saves.statuses.set(path, status('failed', 'EACCES'));
        return false;
      }
      saves.statuses.set(path, status('clean'));
      return true;
    });
    const h = await mountHook(saves);
    const { settled } = await h.ask({ paths });
    await act(async () => click(button('Save All')));
    expect(settled).not.toHaveBeenCalled();
    expect(h.slot.current?.kind).toBe('dirty');
    const rows = [...document.body.querySelectorAll<HTMLElement>('li.confirm__file')];
    expect(rows.map((r) => r.title)).toEqual(['/p/src/b.ts']);
    expect(rowTags()).toEqual(['save failed: EACCES']);
    expect(document.body.querySelector('.confirm__status')?.textContent).toBe(
      "1 file couldn't be saved",
    );
    expect(button('Save All').disabled).toBe(false);
  });

  it("Don't Save → discarded", async () => {
    const paths = ['/p/src/a.ts'];
    const saves = fakeSaves(paths);
    const h = await mountHook(saves);
    const { answer } = await h.ask({ paths });
    await act(async () => click(button("Don't Save")));
    await expect(answer).resolves.toBe('discarded');
    expect(saves.save).not.toHaveBeenCalled();
    expect(h.slot.current).toBeNull();
  });

  it('Cancel while saving → cancel', async () => {
    const paths = ['/p/src/a.ts'];
    const saves = fakeSaves(paths);
    let release: (ok: boolean) => void = () => {};
    saves.save.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const h = await mountHook(saves);
    const { answer, settled } = await h.ask({ paths });
    await act(async () => click(button('Save All')));
    expect(button('Saving…').disabled).toBe(true);
    expect(document.body.querySelector('.confirm__status')?.textContent).toBe('Saving 1 file');
    await act(async () => click(button('Cancel')));
    await expect(answer).resolves.toBe('cancel');
    expect(h.slot.current).toBeNull();
    saves.statuses.set('/p/src/a.ts', status('clean'));
    await act(async () => release(true));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith('cancel');
    expect(h.slot.current).toBeNull();
  });

  it('Escape → cancel', async () => {
    const paths = ['/p/src/a.ts'];
    const h = await mountHook(fakeSaves(paths));
    const { answer } = await h.ask({ paths });
    await act(async () => pressEscape());
    await expect(answer).resolves.toBe('cancel');
    expect(h.slot.current).toBeNull();
  });

  it('displaced by a confirm opened through the slot → cancel', async () => {
    const paths = ['/p/src/a.ts'];
    const h = await mountHook(fakeSaves(paths));
    const { answer } = await h.ask({ paths });
    const key = nextModalKey();
    await act(async () =>
      h.slot.open({
        kind: 'confirm',
        key,
        state: { title: 't', message: 'm', onConfirm: vi.fn() },
      }),
    );
    await expect(answer).resolves.toBe('cancel');
    expect(h.slot.current?.key).toBe(key);
    expect(document.body.querySelector('.fake-confirm')).not.toBeNull();
  });

  it('second ask displaces the first → first resolves cancel', async () => {
    const paths = ['/p/src/a.ts'];
    const h = await mountHook(fakeSaves(paths));
    const first = await h.ask({ paths });
    const second = await h.ask({ paths });
    await expect(first.answer).resolves.toBe('cancel');
    expect(second.settled).not.toHaveBeenCalled();
    expect(h.slot.current?.kind).toBe('dirty');
    await act(async () => click(button("Don't Save")));
    await expect(second.answer).resolves.toBe('discarded');
  });

  it('aborting signal closes without settling → cancel, onCancel side effects not run twice', async () => {
    const paths = ['/p/src/a.ts'];
    const h = await mountHook(fakeSaves(paths));
    const controller = new AbortController();
    const { answer, settled } = await h.ask({ paths, signal: controller.signal });
    const entry = h.slot.current;
    if (entry?.kind !== 'dirty') throw new Error('expected a dirty entry');
    const close = vi.spyOn(h.slot, 'close');
    await act(async () => controller.abort());
    await expect(answer).resolves.toBe('cancel');
    expect(close).toHaveBeenCalledWith(entry.key);
    expect(h.slot.current).toBeNull();
    await act(async () => entry.props.onCancel());
    await act(async () => {});
    expect(settled).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal resolves cancel without opening', async () => {
    const paths = ['/p/src/a.ts'];
    const h = await mountHook(fakeSaves(paths));
    const controller = new AbortController();
    controller.abort();
    const { answer } = await h.ask({ paths, signal: controller.signal });
    await expect(answer).resolves.toBe('cancel');
    expect(h.slot.current).toBeNull();
  });

  it('settles exactly once', async () => {
    const paths = ['/p/src/a.ts'];
    const saves = fakeSaves(paths);
    const h = await mountHook(saves);
    const { answer, settled } = await h.ask({ paths });
    const entry = h.slot.current;
    if (entry?.kind !== 'dirty') throw new Error('expected a dirty entry');
    await act(async () => entry.props.onDiscard());
    const other = nextModalKey();
    await act(async () =>
      h.slot.open({
        kind: 'confirm',
        key: other,
        state: { title: 't', message: 'm', onConfirm: vi.fn() },
      }),
    );
    await act(async () => {
      entry.props.onCancel();
      entry.props.onSaveAll();
      entry.props.onDiscard();
    });
    await expect(answer).resolves.toBe('discarded');
    expect(settled).toHaveBeenCalledTimes(1);
    expect(saves.save).not.toHaveBeenCalled();
    expect(h.slot.current?.key).toBe(other);
    expect(saves.listeners.size).toBe(0);
  });

  it('a listed path turning clean re-tags "Saved" via saves.subscribe', async () => {
    const paths = ['/p/src/a.ts', '/p/src/b.ts'];
    const saves = fakeSaves(paths);
    const h = await mountHook(saves);
    await h.ask({ paths });
    expect(rowTags()).toEqual([null, null]);
    saves.statuses.set('/p/src/a.ts', status('clean'));
    await act(async () => saves.emit());
    expect(rowTags()).toEqual(['Saved', null]);
    expect(document.body.querySelector('.confirm__title')?.textContent).toBe(
      'Do you want to save the changes you made to b.ts?',
    );
    await act(async () => click(button('Save All')));
    expect(saves.save.mock.calls).toEqual([['/p/src/b.ts', 'manual']]);
    expect(h.slot.current).toBeNull();
  });
});
