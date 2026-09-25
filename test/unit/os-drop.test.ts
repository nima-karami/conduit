import { describe, expect, it } from 'vitest';
import { mapDropItems, planOsDrop } from '../../src/os-drop';

const dir = (path: string) => ({ path, isDir: true });
const file = (path: string) => ({ path, isDir: false });
const SESSION = ['/w/home', '/w/att'];

describe('mapDropItems', () => {
  it('mapDropItems: isDirectory true/false/null; empty path dropped', () => {
    expect(
      mapDropItems([
        { path: '/x/a', entry: { isDirectory: true } },
        { path: '/x/b.txt', entry: { isDirectory: false } },
        { path: '/x/c', entry: null },
        { path: '', entry: { isDirectory: true } },
      ]),
    ).toEqual([
      { path: '/x/a', isDir: true },
      { path: '/x/b.txt', isDir: false },
      { path: '/x/c', isDir: null },
    ]);
  });
});

describe('planOsDrop', () => {
  it('outside folder → attach', () => {
    expect(planOsDrop([dir('/x/ext')], SESSION)).toEqual({ attach: ['/x/ext'], copy: [] });
  });

  it('equal / inside / containing a session folder → copy', () => {
    expect(planOsDrop([dir('/w/att')], SESSION)).toEqual({ attach: [], copy: ['/w/att'] });
    expect(planOsDrop([dir('/w/home/sub')], SESSION)).toEqual({
      attach: [],
      copy: ['/w/home/sub'],
    });
    expect(planOsDrop([dir('/w')], SESSION)).toEqual({ attach: [], copy: ['/w'] });
  });

  it('A and A/sub → attach [A] only', () => {
    expect(planOsDrop([dir('/x/A'), dir('/x/A/sub')], SESSION)).toEqual({
      attach: ['/x/A'],
      copy: [],
    });
  });

  it('files + folder mixed → folder attach, files copy', () => {
    expect(planOsDrop([file('/x/a.txt'), dir('/x/ext'), file('/y/b.md')], SESSION)).toEqual({
      attach: ['/x/ext'],
      copy: ['/x/a.txt', '/y/b.md'],
    });
  });

  it('file inside an attached-eligible dir is not copied', () => {
    expect(planOsDrop([dir('/x/ext'), file('/x/ext/f.txt')], SESSION)).toEqual({
      attach: ['/x/ext'],
      copy: [],
    });
  });

  it('C:\\Work\\x vs c:/work/x counts as equal', () => {
    expect(planOsDrop([dir('C:\\Work\\x')], ['c:/work/x'])).toEqual({
      attach: [],
      copy: ['C:\\Work\\x'],
    });
    expect(planOsDrop([dir('C:\\Work\\x\\in')], ['c:/work/x'])).toEqual({
      attach: [],
      copy: ['C:\\Work\\x\\in'],
    });
  });

  it('missing session folder still blocks attaching itself', () => {
    // Callers pass [home, ...roots] including missing ones; a folder dropped back is not a new one.
    expect(planOsDrop([dir('/w/gone')], ['/w/home', '/w/gone'])).toEqual({
      attach: [],
      copy: ['/w/gone'],
    });
  });
});
