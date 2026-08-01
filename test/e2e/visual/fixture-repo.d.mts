import type { ArchDoc } from '../../../src/architecture';

/** Build (once) the throwaway visual-verification repo; returns its root. */
export function ensureFixtureRepo(): string;
export const FIXTURE_ROOT: string;

/** Put a pending `.conduit/architecture.proposed.json` on disk, or remove it. */
export function setArchProposal(present: boolean): void;

/** The canvas graph the fixture commits, and the agent proposal the canvas scenes drop beside it. */
export const ARCH_FIXTURE_DOC: ArchDoc;
export const ARCH_FIXTURE_PROPOSAL: ArchDoc;
