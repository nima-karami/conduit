import type { HumanPresence } from '../../src/conduit-mcp/request-types';
import { awayLabel } from '../away-view-model';
import { awayStr, REQ_STR } from '../request-strings';

export interface AwayBannerProps {
  presence: HumanPresence;
  onBack(): void;
}

export function AwayBanner(p: AwayBannerProps): React.JSX.Element | null {
  if (p.presence.state !== 'away') return null;
  const until = p.presence.until;
  return (
    <section className="needs-away__banner">
      <p className="needs-away__title">
        {until === null ? awayStr.bannerAway : awayStr.bannerUntil(awayLabel(until))}
      </p>
      <p className="needs-away__text">{awayStr.explainer}</p>
      <button type="button" className="needs-away__back" onClick={p.onBack}>
        {REQ_STR.back}
      </button>
    </section>
  );
}
