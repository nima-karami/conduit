import { createHash } from 'node:crypto';

/** The lowercase hex sha256 the remote scripts and manifests use. */
export const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
