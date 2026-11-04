interface HcResolveOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  exists?: (p: string) => boolean;
  repo?: string;
}
export function onPath(
  name: string,
  o?: Pick<HcResolveOptions, 'env' | 'platform' | 'exists'>,
): string | undefined;
export function resolveHcBinary(o?: HcResolveOptions): string | undefined;
