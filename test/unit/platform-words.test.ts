import { describe, expect, it } from 'vitest';
import { platformWords } from '../../src/platform-words';

// Windows keeps the strings that shipped before this module existed, byte for byte.
describe('platformWords', () => {
  it('win32: Recycle Bin and Reveal in Explorer', () => {
    expect(platformWords('win32')).toEqual({
      trash: 'Recycle Bin',
      moveToTrash: 'Move to Recycle Bin',
      reveal: 'Reveal in Explorer',
      revealProject: 'Reveal project in Explorer',
      revealActiveFile: 'Reveal active file in Explorer',
    });
  });

  it('darwin: Trash and Reveal in Finder', () => {
    expect(platformWords('darwin')).toEqual({
      trash: 'Trash',
      moveToTrash: 'Move to Trash',
      reveal: 'Reveal in Finder',
      revealProject: 'Reveal project in Finder',
      revealActiveFile: 'Reveal active file in Finder',
    });
  });

  it('linux: Trash and Show in Files', () => {
    expect(platformWords('linux')).toEqual({
      trash: 'Trash',
      moveToTrash: 'Move to Trash',
      reveal: 'Show in Files',
      revealProject: 'Show project in Files',
      revealActiveFile: 'Show active file in Files',
    });
  });
});
