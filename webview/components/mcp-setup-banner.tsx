import { useEffect, useLayoutEffect, useState } from 'react';
import type { AgentCli } from '../../src/conduit-mcp/install-types';
import type { McpNotConnected } from '../../src/conduit-mcp/ui-types';
import type { Session } from '../../src/types';
import { mcpInstallAct } from '../bridge';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconClose } from '../icons';
import { log } from '../log';
import {
  BANNER_LEDGER,
  type BannerLedger,
  bannerKey,
  shouldOfferBanner,
} from '../mcp-setup-banner-model';
import { useSettings } from '../settings';

const S = MCP_STR.install;

type Phase =
  | { kind: 'shown' }
  | { kind: 'installing' }
  | { kind: 'installed' }
  | { kind: 'failed'; message: string };

interface Latch {
  key: string;
  cli: AgentCli;
  phase: Phase;
}

const SHOWN: Phase = { kind: 'shown' };

function phaseText(cli: AgentCli, phase: Phase): string {
  switch (phase.kind) {
    case 'shown':
      return S.bannerBody(cli);
    case 'installing':
      return S.bannerInstalling;
    case 'installed':
      return S.bannerInstalled(cli);
    case 'failed':
      return phase.message;
  }
}

/** Suggests installing Conduit for a CLI typed in a terminal that didn't connect (spec 2026-10-27-conduit-mcp-install §2.5). */
export function McpSetupBanner({
  session,
  nc,
  messagingOn,
  onOpenMcpSettings,
  ledger = BANNER_LEDGER,
}: {
  session: Session;
  nc: McpNotConnected | undefined;
  messagingOn: boolean;
  onOpenMcpSettings(cli: AgentCli): void;
  ledger?: BannerLedger;
}) {
  const { settings, update } = useSettings();
  const suggest = settings.mcpInstallSuggest;
  const dismissed = settings.mcpInstallPromptDismissed;
  const [latch, setLatch] = useState<Latch | null>(null);

  const key = nc ? bannerKey(session.id, nc) : null;
  const otherBannerShowing = !!session.agentScope;
  const offerInput = { nc, messagingOn, suggest, dismissed, otherBannerShowing };
  const offer = shouldOfferBanner({ ...offerInput, seen: key !== null && ledger.has(key) });
  // Spec §2.5 drops it for this launch when only the other banner is in the way; any other unmet
  // condition leaves the key open, so e.g. an uninstall later in the same launch can still offer it.
  const dropped =
    key !== null &&
    !ledger.has(key) &&
    shouldOfferBanner({ ...offerInput, otherBannerShowing: false, seen: false }) &&
    otherBannerShowing;
  const cli = nc?.cli;

  // Once shown, the banner holds through install and its outcome: a successful install flips
  // nc.install to 'installed', which must not take the restart hint away.
  const latched =
    latch !== null && latch.key === key && messagingOn && suggest && !dismissed[latch.cli];
  const visible = offer || latched;

  useLayoutEffect(() => {
    if (key === null || cli === undefined) return;
    if (offer) {
      ledger.mark(key);
      setLatch({ key, cli, phase: SHOWN });
    } else if (dropped) {
      ledger.mark(key);
    }
  }, [key, cli, offer, dropped, ledger]);

  // A live region mounted with its text is often not read; fill it one commit after it appears.
  const [live, setLive] = useState(false);
  useEffect(() => {
    setLive(visible);
  }, [visible]);

  if (!visible || key === null || cli === undefined) return null;
  const phase = latch?.key === key ? latch.phase : SHOWN;

  const setPhase = (next: Phase) =>
    setLatch((l) => (l && l.key === key ? { ...l, phase: next } : l));

  const install = async () => {
    setPhase({ kind: 'installing' });
    try {
      const r = await mcpInstallAct({ cli, scope: 'user', action: 'install' });
      setPhase(
        r.ok
          ? { kind: 'installed' }
          : { kind: 'failed', message: S.actionFailed(r.status.user.path, r.errorCode) },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn('mcp-install', 'banner install failed', { error: detail, cli });
      setPhase({ kind: 'failed', message: S.actionFailed('', 'EINVAL') });
    }
  };

  const announcement = phase.kind === 'shown' ? S.bannerAnnounce(cli) : phaseText(cli, phase);
  const busy = phase.kind === 'installing';

  return (
    <div className="mcp-banner" role="region" aria-label={S.bannerRegion}>
      <div className="sr-only" role="status" aria-live="polite">
        {live ? announcement : ''}
      </div>
      <div className="mcp-banner__msg">{phaseText(cli, phase)}</div>
      <div className="mcp-banner__actions">
        {(phase.kind === 'shown' || phase.kind === 'installing') && (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => void install()}
            >
              {S.bannerInstall(cli)}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => {
                update({ mcpInstallPromptDismissed: { ...dismissed, [cli]: true } });
                setLatch(null);
              }}
            >
              {S.bannerDismiss}
            </button>
          </>
        )}
        {phase.kind === 'failed' && (
          <button type="button" className="btn btn--sm" onClick={() => onOpenMcpSettings(cli)}>
            {S.bannerOpenSettings}
          </button>
        )}
        <button
          type="button"
          className="mcp-banner__close"
          aria-label={S.bannerClose}
          title={S.bannerClose}
          onClick={() => setLatch(null)}
        >
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
}
