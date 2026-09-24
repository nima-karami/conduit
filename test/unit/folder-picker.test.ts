import { describe, expect, it, vi } from 'vitest';
import { createFolderPicker, type FolderPickerDeps } from '../../electron/folder-picker';

type Win = Parameters<FolderPickerDeps['showOpenDialog']>[0];
const winA = { id: 1 } as unknown as Win;
const winB = { id: 2 } as unknown as Win;

function setup(e2e: boolean, answer: () => Promise<{ canceled: boolean; filePaths: string[] }>) {
  let hook: { queue(paths: (string | null)[]): void } | undefined;
  const showOpenDialog = vi.fn(answer);
  const picker = createFolderPicker({
    showOpenDialog,
    e2e,
    installHook: (h) => {
      hook = h;
    },
  });
  return { picker, showOpenDialog, hook: () => hook };
}

const picked = (p: string) => async () => ({ canceled: false, filePaths: [p] });

describe('createFolderPicker', () => {
  it('e2e: hook installed; queued paths answer picks in order, null included', async () => {
    const { picker, hook, showOpenDialog } = setup(true, picked('/native'));
    hook()?.queue(['/a', null, '/b']);
    expect(await picker.pick(winA, 'Add a folder')).toBe('/a');
    expect(await picker.pick(winA, 'Add a folder')).toBeNull();
    expect(await picker.pick(winB, 'Add a folder')).toBe('/b');
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('e2e with empty queue → native dialog', async () => {
    const { picker, showOpenDialog } = setup(true, picked('/native'));
    expect(await picker.pick(winA, 'Add a folder')).toBe('/native');
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it('not e2e → hook never installed', () => {
    const { hook } = setup(false, picked('/x'));
    expect(hook()).toBeUndefined();
  });

  it('cancelled → null', async () => {
    const { picker } = setup(false, async () => ({ canceled: true, filePaths: [] }));
    expect(await picker.pick(winA, 'Add a folder')).toBeNull();
  });

  it('second pick for the same window while one is open → null, dialog shown once', async () => {
    let resolve: (v: { canceled: boolean; filePaths: string[] }) => void = () => {};
    const { picker, showOpenDialog } = setup(
      false,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = picker.pick(winA, 'Add a folder');
    expect(await picker.pick(winA, 'Add a folder')).toBeNull();
    resolve({ canceled: false, filePaths: ['/x'] });
    expect(await first).toBe('/x');
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it('dialog called with {properties:[openDirectory], title} and the window', async () => {
    const { picker, showOpenDialog } = setup(false, picked('/x'));
    await picker.pick(winA, 'Add a folder');
    expect(showOpenDialog).toHaveBeenCalledWith(winA, {
      properties: ['openDirectory'],
      title: 'Add a folder',
    });
  });

  it('a pick after the dialog settles opens a new one', async () => {
    const { picker, showOpenDialog } = setup(false, picked('/x'));
    await picker.pick(winA, 't');
    await picker.pick(winA, 't');
    expect(showOpenDialog).toHaveBeenCalledTimes(2);
  });
});
