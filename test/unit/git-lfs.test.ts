import { describe, expect, it } from 'vitest';
import { parseLfsPointer } from '../../src/git-lfs';

const OID = 'a'.repeat(64);
const pointer = (body: string) => Buffer.from(body, 'utf8');

describe('parseLfsPointer', () => {
  it('reads the oid and size of a spec v1 pointer', () => {
    const buf = pointer(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`,
    );
    expect(parseLfsPointer(buf)).toEqual({ oid: OID, size: 12345 });
  });

  it('accepts the legacy hawser header', () => {
    const buf = pointer(`version https://hawser.github.com/spec/v1\noid sha256:${OID}\nsize 3\n`);
    expect(parseLfsPointer(buf)).toEqual({ oid: OID, size: 3 });
  });

  it('tolerates extension lines between version and oid', () => {
    const buf = pointer(
      `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'b'.repeat(64)}\noid sha256:${OID}\nsize 7\n`,
    );
    expect(parseLfsPointer(buf)).toEqual({ oid: OID, size: 7 });
  });

  it('is null for real image bytes and for look-alikes', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect(parseLfsPointer(png)).toBeNull();
    expect(parseLfsPointer(pointer(`oid sha256:${OID}\nsize 1\n`))).toBeNull();
    expect(
      parseLfsPointer(
        pointer('version https://git-lfs.github.com/spec/v1\noid sha256:xyz\nsize 1\n'),
      ),
    ).toBeNull();
    const big = Buffer.concat([
      pointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 1\n`),
      Buffer.alloc(2048),
    ]);
    expect(parseLfsPointer(big)).toBeNull();
  });
});
