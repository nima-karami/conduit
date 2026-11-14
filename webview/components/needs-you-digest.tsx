import { awayLabel, type DigestCounts } from '../away-view-model';
import { awayStr, REQ_STR } from '../request-strings';

export interface NeedsYouDigestProps {
  counts: DigestCounts;
  onDismiss(): void;
  onShowHistory(): void;
}

export function NeedsYouDigest(p: NeedsYouDigestProps): React.JSX.Element {
  const { counts: c } = p;
  const show = (label: string) => (
    <>
      {' · '}
      <button type="button" className="needs-digest__show" onClick={p.onShowHistory}>
        {label}
      </button>
    </>
  );
  return (
    <section className="needs-digest" aria-label={REQ_STR.digestTitle}>
      <header className="needs-digest__head">
        <h3 className="needs-digest__title">{REQ_STR.digestTitle}</h3>
        <button type="button" className="needs-digest__dismiss" onClick={p.onDismiss}>
          {REQ_STR.dismiss}
        </button>
      </header>
      <p className="needs-digest__window">
        {awayStr.window(awayLabel(c.from), awayLabel(c.to))}
        {' · '}
        {c.durationLabel}
      </p>
      <p className="needs-digest__line">
        <strong>{REQ_STR.stillNeedYou(c.stillNeedYou)}</strong>, {awayStr.listedBelow}
      </p>
      {c.wentWithDefault > 0 && (
        <p className="needs-digest__line">
          {REQ_STR.wentWithDefaultN(c.wentWithDefault)}
          {show(REQ_STR.showItems)}
        </p>
      )}
      {c.expired > 0 && (
        <p className="needs-digest__line">
          {REQ_STR.expiredN(c.expired)}
          {show(REQ_STR.showItems)}
        </p>
      )}
      {c.cleared > 0 && (
        <p className="needs-digest__line">
          {REQ_STR.clearedN(c.cleared)}
          {show(REQ_STR.showItems)}
        </p>
      )}
    </section>
  );
}
