import { expectTypeOf, it } from 'vitest';
import type { HcClient, HcStream } from '../../src/contracts/hc';
import type { NodeHcClient } from '../../src/hc-client';

it('implements the frozen C3 client and stream signatures', () => {
  expectTypeOf<NodeHcClient>().toExtend<HcClient>();
  expectTypeOf<Awaited<ReturnType<NodeHcClient['attach']>>['stream']>().toEqualTypeOf<HcStream>();
});
