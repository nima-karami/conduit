import { expectTypeOf, it } from 'vitest';
import type { HcClient, HcErrorKind, HcStream } from '../../src/contracts/hc';
import type { HC_ERROR_KINDS, NodeHcClient } from '../../src/hc-client';

it('implements the frozen C3 client and stream signatures', () => {
  expectTypeOf<NodeHcClient>().toExtend<HcClient>();
  expectTypeOf<Awaited<ReturnType<NodeHcClient['attach']>>['stream']>().toEqualTypeOf<HcStream>();
});

it('recognizes exactly the C3 error kinds', () => {
  expectTypeOf<(typeof HC_ERROR_KINDS)[number]>().toEqualTypeOf<HcErrorKind>();
});
