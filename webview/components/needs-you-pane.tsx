import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import type { RequestsUiState, RequestView } from '../../src/conduit-mcp/request-types';
import type { Session } from '../../src/types';
import { REQ_STR } from '../request-strings';
import {
  ageLabel,
  applyFilters,
  type CardView,
  cardsOf,
  machineNamesOf,
  type RequestFilters,
  type RequestType,
  type SessionInfo,
  type ShowOnCards,
  type SortKey,
  sortRequests,
} from '../request-view-model';
import { RequestTypeIcon } from './request-type-icon';

export interface NeedsYouPaneProps {
  requests: RequestsUiState | null;
  sessions: readonly Session[];
  spaceNames: ReadonlyMap<string, string>;
  sort: SortKey;
  filters: RequestFilters;
  show: ShowOnCards;
  onClearFilters(): void;
  menu: ReactNode;
  legendOpen: boolean;
  onCloseLegend(): void;
  onOpen(requestId: string): void;
  onOpenTerminal(sessionId: string): void;
  now: number;
  /** Bumped to switch the list to History (the return digest's "show"). */
  historySignal?: number;
}

const ANNOUNCE_EVERY_MS = 5_000;
const ZWSP = String.fromCharCode(0x200b);
const SKELETON_ROWS = [0, 1, 2];
const TYPE_TEXT: Record<RequestType, string> = {
  approve: REQ_STR.needsPane.legendApprove,
  answer: REQ_STR.needsPane.legendAnswer,
  review: REQ_STR.needsPane.legendReview,
};

/** Coalesces arrivals to one announcement per interval; the first snapshot is not news. */
function useArrivalAnnouncer(requests: RequestsUiState | null): string {
  const [text, setText] = useState('');
  const seen = useRef<Set<string> | null>(null);
  const pending = useRef(0);
  const last = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!requests) return;
    const ids = requests.open.map((r) => r.id);
    const before = seen.current;
    seen.current = new Set(ids);
    if (before === null) return;
    const n = ids.filter((id) => !before.has(id)).length;
    if (n <= 0) return;
    pending.current += n;
    const flush = () => {
      timer.current = null;
      const said = REQ_STR.needsPane.newRequests(pending.current);
      setText((cur) => (cur === said ? `${said}${ZWSP}` : said));
      pending.current = 0;
      last.current = Date.now();
    };
    const wait = last.current + ANNOUNCE_EVERY_MS - Date.now();
    if (wait <= 0) flush();
    else if (!timer.current) timer.current = setTimeout(flush, wait);
  }, [requests]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return text;
}

function filterNames(
  f: RequestFilters,
  sessions: ReadonlyMap<string, SessionInfo>,
  spaces: ReadonlyMap<string, string>,
  machines: ReadonlyMap<string, string>,
): string {
  const session = (id: string) => sessions.get(id)?.name ?? id;
  return [
    ...f.sessions.map(session),
    ...f.leads.map(session),
    ...f.spaces.map((id) => spaces.get(id) ?? id),
    ...f.types.map((t) => REQ_STR.typeWord[t]),
    ...f.machines.map((id) => machines.get(id) ?? id),
  ].join(', ');
}

function endedWord(r: RequestView): string {
  switch (r.state) {
    case 'answered':
      return r.answer?.answeredBy.kind === 'default' ? REQ_STR.wentWithDefault : REQ_STR.answered;
    case 'expired':
      return REQ_STR.expired;
    case 'withdrawn':
      return r.requester === 'conduit' || r.withdrawnBy === 'conduit'
        ? REQ_STR.withdrawnByConduit
        : REQ_STR.withdrawnBy(r.requester);
    case 'superseded':
      return REQ_STR.replaced;
    case 'resolved':
      return REQ_STR.clearedByItself;
    case 'orphaned':
      return REQ_STR.notDelivered;
    case 'open':
      throw new Error('an open request is not listed in History');
  }
}

function WhyChip({ why, now }: { why: CardView['whyNow']; now: number }): JSX.Element {
  switch (why.kind) {
    case 'waiting':
      return (
        <span className="needs-chip needs-chip--waiting">{REQ_STR.waiting(why.secondsLeft)}</span>
      );
    case 'urgent':
      return <span className="needs-chip needs-chip--urgent">{REQ_STR.urgent}</span>;
    case 'expires':
      // ageLabel measures elapsed time; mirroring the expiry instant around now turns it into time left.
      return (
        <span className="needs-chip">
          {REQ_STR.expires(ageLabel(new Date(2 * now - Date.parse(why.at)).toISOString(), now))}
        </span>
      );
    case 'tab':
      return <span className="needs-chip">{`⧉ ${REQ_STR.tabLines(why.lines)}`}</span>;
    case 'terminal':
      return <span className="needs-chip">{`›_ ${REQ_STR.inTerminal}`}</span>;
    case 'age':
      return <span className="needs-row__age">{why.label}</span>;
  }
}

export function NeedsYouPane(p: NeedsYouPaneProps): JSX.Element {
  const { requests, sessions, spaceNames, sort, filters, show, now } = p;
  const baseId = useId();
  const [view, setView] = useState<'open' | 'history'>('open');
  useEffect(() => {
    if (p.historySignal) setView('history');
  }, [p.historySignal]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const announcement = useArrivalAnnouncer(requests);

  const sessionMap = new Map<string, SessionInfo>(
    sessions.map((s): [string, SessionInfo] => [
      s.id,
      { name: s.name, handle: s.mcpHandle ?? null },
    ]),
  );
  const openTotal = requests?.open.length ?? 0;
  const filterActive =
    filters.sessions.length +
      filters.leads.length +
      filters.spaces.length +
      filters.types.length +
      filters.machines.length >
    0;

  const { shown } = applyFilters(requests?.open ?? [], filters);
  const openSorted = sortRequests(shown, sort, sessionMap);
  const openCards = cardsOf(openSorted, { now, sessions: sessionMap, spaces: spaceNames });
  const endedSorted = sortRequests(requests?.ended ?? [], 'newest', sessionMap);
  const endedCards = cardsOf(endedSorted, { now, sessions: sessionMap, spaces: spaceNames });

  const rows = view === 'open' ? openCards : endedCards;
  const activeIndex = Math.max(
    rows.findIndex((c) => c.id === activeId),
    0,
  );
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'h') {
      e.preventDefault();
      setView((v) => (v === 'open' ? 'history' : 'open'));
      setActiveId(null);
      return;
    }
    if (rows.length === 0) return;
    const go = (i: number) => {
      e.preventDefault();
      setActiveId(rows[i].id);
      document.getElementById(optionId(i))?.scrollIntoView({ block: 'nearest' });
    };
    if (k === 'ArrowDown' || k === 'j') go(Math.min(activeIndex + 1, rows.length - 1));
    else if (k === 'ArrowUp' || k === 'k') go(Math.max(activeIndex - 1, 0));
    else if (k === 'Home') go(0);
    else if (k === 'End') go(rows.length - 1);
    else if (k === 'Enter') {
      e.preventDefault();
      p.onOpen(rows[activeIndex].id);
    } else if (k === 'o') {
      const sessionId = rows[activeIndex].sessionId;
      if (sessionId !== null) {
        e.preventDefault();
        p.onOpenTerminal(sessionId);
      }
    }
  };

  const viewRow = (
    <div className="needs-viewrow">
      <div className="needs-seg" role="group" aria-label={REQ_STR.panelTitle}>
        <button
          type="button"
          className="needs-seg__btn"
          aria-pressed={view === 'open'}
          onClick={() => {
            setView('open');
            setActiveId(null);
          }}
        >
          {REQ_STR.open(openTotal)}
        </button>
        <button
          type="button"
          className="needs-seg__btn"
          aria-pressed={view === 'history'}
          onClick={() => {
            setView('history');
            setActiveId(null);
          }}
        >
          {REQ_STR.history}
        </button>
      </div>
      <span className="needs-sort">{REQ_STR.sort[sort]}</span>
      <span className="needs-viewrow__menu">{p.menu}</span>
    </div>
  );

  const filterBar = filterActive ? (
    <div className="needs-filterbar">
      <span className="needs-filterbar__text">
        {REQ_STR.needsPane.filtered(
          filterNames(filters, sessionMap, spaceNames, machineNamesOf(requests?.open ?? [])),
          shown.length,
          openTotal,
        )}
      </span>
      <button type="button" className="needs-filterbar__clear" onClick={p.onClearFilters}>
        {REQ_STR.clear}
      </button>
    </div>
  ) : null;

  const legend = p.legendOpen ? (
    <section className="needs-legend" aria-label={REQ_STR.legend}>
      <h3 className="needs-legend__head">{REQ_STR.needsPane.legendAsked}</h3>
      {(['approve', 'answer', 'review'] as const).map((t) => (
        <div key={t} className="needs-legend__row needs-legend__row--type">
          <RequestTypeIcon type={t} label={REQ_STR.typeWord[t]} size={18} />
          <span className="needs-legend__name">{REQ_STR.typeWord[t]}</span>
          <span className="needs-legend__text">{TYPE_TEXT[t]}</span>
        </div>
      ))}
      <h3 className="needs-legend__head">{REQ_STR.needsPane.legendOpens}</h3>
      <div className="needs-legend__row">
        <span className="needs-legend__sample" />
        <span className="needs-legend__text">{REQ_STR.needsPane.markerPopup}</span>
      </div>
      <div className="needs-legend__row">
        <span className="needs-legend__sample">
          <span className="needs-chip">{`⧉ ${REQ_STR.tabLines(46)}`}</span>
        </span>
        <span className="needs-legend__text">{REQ_STR.needsPane.markerTab}</span>
      </div>
      <div className="needs-legend__row">
        <span className="needs-legend__sample">
          <span className="needs-chip">{`›_ ${REQ_STR.inTerminal}`}</span>
        </span>
        <span className="needs-legend__text">{REQ_STR.needsPane.markerTerminal}</span>
      </div>
      <h3 className="needs-legend__head">{REQ_STR.needsPane.legendAlso}</h3>
      <div className="needs-legend__row">
        <span className="needs-legend__sample">
          <span className="needs-conduit">{REQ_STR.conduit}</span>
        </span>
        <span className="needs-legend__text">{REQ_STR.needsPane.conduitMeaning}</span>
      </div>
      <div className="needs-legend__row">
        <span className="needs-legend__sample">
          <span className="needs-chip needs-chip--waiting">{REQ_STR.waiting(58)}</span>
        </span>
        <span className="needs-legend__text">{REQ_STR.needsPane.waitingMeaning}</span>
      </div>
      <button type="button" className="needs-legend__close" onClick={p.onCloseLegend}>
        {REQ_STR.needsPane.closeLegend}
      </button>
    </section>
  ) : null;

  let body: ReactNode;
  if (requests === null) {
    body = (
      <div className="needs-skeleton" aria-hidden="true">
        {SKELETON_ROWS.map((i) => (
          <div key={i} className="needs-skeleton-row" />
        ))}
      </div>
    );
  } else if (view === 'open' && openTotal === 0) {
    body =
      requests.ended.length === 0 ? (
        <div className="needs-empty">
          <p className="needs-empty__title">{REQ_STR.empty}</p>
          <p className="needs-empty__text">{REQ_STR.needsPane.emptyPurpose}</p>
        </div>
      ) : (
        <div className="needs-empty">
          <p className="needs-empty__title">{REQ_STR.caughtUp}</p>
        </div>
      );
  } else if (view === 'open' && openCards.length === 0) {
    body = (
      <div className="needs-empty">
        <p className="needs-empty__title">{REQ_STR.filteredEmpty}</p>
        <button type="button" className="needs-filterbar__clear" onClick={p.onClearFilters}>
          {REQ_STR.clear}
        </button>
      </div>
    );
  } else if (view === 'history' && endedCards.length === 0) {
    body = (
      <div className="needs-empty">
        <p className="needs-empty__text">{REQ_STR.needsPane.historyEmpty}</p>
      </div>
    );
  } else {
    body = (
      <div
        role="listbox"
        aria-label={view === 'open' ? REQ_STR.panelTitle : REQ_STR.history}
        aria-activedescendant={rows.length > 0 ? optionId(activeIndex) : undefined}
        tabIndex={0}
        className="needs-list"
        onKeyDown={onKeyDown}
      >
        {view === 'open'
          ? openCards.flatMap((c, i) => {
              const option = (
                <div
                  key={c.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  aria-label={c.ariaName}
                  className={`needs-row${i === activeIndex ? ' needs-row--active' : ''}`}
                  onClick={() => {
                    setActiveId(c.id);
                    p.onOpen(c.id);
                  }}
                >
                  <div className="needs-row__line">
                    <RequestTypeIcon
                      type={c.type}
                      conduit={c.conduit}
                      label={REQ_STR.typeWord[c.type]}
                      size={18}
                    />
                    <span className="needs-row__session">{c.sessionName}</span>
                    {c.handle !== '' && <span className="needs-row__handle">{c.handle}</span>}
                    <span className="needs-row__why">
                      <WhyChip why={c.whyNow} now={now} />
                    </span>
                    {c.stale && (
                      <span className="needs-chip">{REQ_STR.offline(c.details.machine)}</span>
                    )}
                  </div>
                  <div className="needs-row__line">
                    {c.conduit && <span className="needs-conduit">{REQ_STR.conduit}</span>}
                    <span className="needs-row__ask">{c.ask}</span>
                  </div>
                  {detailsOf(c, show)}
                </div>
              );
              const heading =
                sort === 'session' && (i === 0 || openCards[i - 1].sessionId !== c.sessionId) ? (
                  <div key={`h-${c.id}`} role="presentation" className="needs-group">
                    {c.sessionName}
                  </div>
                ) : null;
              return heading ? [heading, option] : [option];
            })
          : endedCards.map((c, i) => {
              const r = endedSorted[i];
              return (
                <div
                  key={c.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  aria-label={c.ariaName}
                  className={`needs-row${i === activeIndex ? ' needs-row--active' : ''}`}
                  onClick={() => {
                    setActiveId(c.id);
                    p.onOpen(c.id);
                  }}
                >
                  <div className="needs-row__line">
                    <RequestTypeIcon
                      type={c.type}
                      conduit={c.conduit}
                      label={REQ_STR.typeWord[c.type]}
                      size={18}
                    />
                    <span className="needs-row__session">{c.sessionName}</span>
                    {c.handle !== '' && <span className="needs-row__handle">{c.handle}</span>}
                    <span className="needs-row__why">{endedWord(r)}</span>
                  </div>
                  <div className="needs-row__line">
                    {c.conduit && <span className="needs-conduit">{REQ_STR.conduit}</span>}
                    <span className="needs-row__ask">{c.ask}</span>
                  </div>
                </div>
              );
            })}
      </div>
    );
  }

  return (
    <div className="needs-pane">
      {viewRow}
      {filterBar}
      {legend}
      {body}
      <div className="needs-sr" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** Space, age and machine, each once: an age that is already the why-now chip is not repeated. */
function detailsOf(c: CardView, show: ShowOnCards): ReactNode {
  const parts = [
    show.space ? c.details.space : null,
    show.age && c.whyNow.kind !== 'age' ? c.details.age : null,
    show.machine || c.remote ? c.details.machine : null,
  ].filter((x): x is string => x !== null && x !== '');
  if (parts.length === 0) return null;
  return <div className="needs-row__details">{parts.join(' · ')}</div>;
}
