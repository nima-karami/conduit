import { describe, expect, it } from 'vitest';
import { folderKey } from '../../src/folder-key';

describe('folderKey', () => {
  it('drive-letter paths fold case and slashes', () => {
    expect(folderKey('C:\\a\\x')).toBe('c:/a/x');
    expect(folderKey('c:/A/x/')).toBe('c:/a/x');
  });

  it('posix paths stay case-sensitive', () => {
    expect(folderKey('/Work/x')).toBe('/Work/x');
    expect(folderKey('/work/x/')).toBe('/work/x');
    expect(folderKey('/Work/x')).not.toBe(folderKey('/work/x'));
  });

  it('UNC folds case', () => {
    expect(folderKey('\\\\Srv\\Share')).toBe(folderKey('\\\\srv\\share'));
    expect(folderKey('//Srv/Share/Dir/')).toBe('//srv/share/dir');
  });
});
