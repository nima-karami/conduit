import type { InstallDismissals } from '../src/conduit-mcp/install-types';
import type { McpNotConnected } from '../src/conduit-mcp/ui-types';

/** One banner per CLI per session per host launch (spec 2026-10-27-conduit-mcp-install §2.5). */
export function bannerKey(sessionId: string, nc: McpNotConnected): string {
  return `${sessionId}:${nc.cli}:${nc.launch}`;
}

export interface BannerLedger {
  has(key: string): boolean;
  mark(key: string): void;
}

export function createBannerLedger(): BannerLedger {
  const seen = new Set<string>();
  return {
    has: (key) => seen.has(key),
    mark: (key) => {
      seen.add(key);
    },
  };
}

// Module-wide so a pane remount can't offer the same launch twice.
export const BANNER_LEDGER: BannerLedger = createBannerLedger();

// spec 2026-10-27-conduit-mcp-install §2.5
export function shouldOfferBanner(i: {
  nc: McpNotConnected | undefined;
  messagingOn: boolean;
  suggest: boolean;
  dismissed: InstallDismissals;
  otherBannerShowing: boolean;
  seen: boolean;
}): boolean {
  return (
    !!i.nc &&
    i.messagingOn &&
    i.suggest &&
    !i.dismissed[i.nc.cli] &&
    i.nc.install === 'not-installed' &&
    !i.otherBannerShowing &&
    !i.seen
  );
}
