import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  type ChangelogEntry,
  changelogEntries,
  defaultEntryIndex,
  releaseDateLabel,
} from '../../src/changelog';
import { openExternal, readChangelog } from '../bridge';
import { CHROME_STR } from '../chrome-strings';
import { middleClickProps } from '../middle-click';
import { ReleaseNotesMarkdown, releaseTagUrl } from './release-notes-markdown';

const STR = CHROME_STR.releaseNotes;

type Load =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; entries: ChangelogEntry[] };

const KEY_STEP: Record<string, (index: number, last: number) => number> = {
  ArrowUp: (i) => Math.max(0, i - 1),
  ArrowDown: (i, last) => Math.min(last, i + 1),
  Home: () => 0,
  End: (_i, last) => last,
};

/** Settings → Release notes: every version in the bundled CHANGELOG.md, one at a time. */
export function ReleaseNotesPage({ installedVersion }: { installedVersion?: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [selected, setSelected] = useState(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const fetchNotes = useCallback(() => {
    setLoad({ state: 'loading' });
    readChangelog().then(
      (text) => {
        if (!mounted.current) return;
        const entries = text === null ? [] : changelogEntries(text);
        setSelected(defaultEntryIndex(entries, installedVersion));
        setLoad({ state: 'ready', entries });
      },
      () => {
        if (mounted.current) setLoad({ state: 'failed' });
      },
    );
  }, [installedVersion]);
  useEffect(fetchNotes, [fetchNotes]);

  if (load.state === 'failed') {
    return (
      <div className="relnotes relnotes--status" data-release-notes="failed">
        <p className="relnotes__status">
          {STR.failed}
          <button type="button" className="about__checkbtn" onClick={fetchNotes}>
            {STR.retry}
          </button>
        </p>
      </div>
    );
  }
  if (load.state === 'ready' && load.entries.length === 0) {
    return (
      <div className="relnotes relnotes--status" data-release-notes="empty">
        <p className="relnotes__status">{STR.empty}</p>
      </div>
    );
  }
  const entries = load.state === 'ready' ? load.entries : [];
  return (
    <div className="relnotes" data-release-notes={load.state}>
      <VersionRail
        entries={entries}
        selected={selected}
        installedVersion={installedVersion}
        onSelect={setSelected}
      />
      {entries[selected] && (
        <VersionNotes
          entry={entries[selected]}
          installed={entries[selected].version === installedVersion}
        />
      )}
    </div>
  );
}

function VersionRail({
  entries,
  selected,
  installedVersion,
  onSelect,
}: {
  entries: ChangelogEntry[];
  selected: number;
  installedVersion?: string;
  onSelect(index: number): void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const newestYear = entries[0]?.date?.slice(0, 4);

  // Opening on the installed version must show it even when it sits far down the rail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first list, not every move
  useLayoutEffect(() => {
    railRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [entries]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = KEY_STEP[e.key];
      if (!step || entries.length === 0) return;
      e.preventDefault();
      const next = step(selected, entries.length - 1);
      onSelect(next);
      const option = railRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`);
      option?.focus();
      option?.scrollIntoView({ block: 'nearest' });
    },
    [entries.length, selected, onSelect],
  );

  return (
    <div
      ref={railRef}
      className="relnotes__rail"
      role="listbox"
      aria-label={STR.versions}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, i) => (
        <div
          key={entry.version}
          data-index={i}
          role="option"
          aria-selected={i === selected}
          tabIndex={i === selected ? 0 : -1}
          className={`relnotes__ver${i === selected ? ' relnotes__ver--active' : ''}`}
          onClick={() => onSelect(i)}
        >
          <span className="relnotes__vername">v{entry.version}</span>
          {entry.version === installedVersion && (
            <span className="relnotes__tag">{STR.installed}</span>
          )}
          {entry.date && (
            <span className="relnotes__verdate">
              {releaseDateLabel(entry.date, 'short', newestYear)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function VersionNotes({ entry, installed }: { entry: ChangelogEntry; installed: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const url = releaseTagUrl(entry.version);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version starts at its top
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [entry.version]);

  return (
    <section
      className="relnotes__notes"
      aria-labelledby={titleId}
      data-release-version={entry.version}
    >
      <header className="relnotes__head">
        <h3 id={titleId} className="relnotes__title">
          v{entry.version}
        </h3>
        <div className="relnotes__meta">
          {entry.date && (
            <time className="relnotes__date" dateTime={entry.date}>
              {releaseDateLabel(entry.date, 'long')}
            </time>
          )}
          {installed && <span className="relnotes__tag">{STR.installed}</span>}
          {!entry.published && (
            <span className="relnotes__tag relnotes__tag--muted" title={STR.unpublishedTitle}>
              {STR.unpublished}
            </span>
          )}
        </div>
        {entry.published && (
          <a
            className="about__link relnotes__gh"
            href={url}
            {...middleClickProps(() => openExternal(url))}
            onClick={(e) => {
              e.preventDefault();
              openExternal(url);
            }}
          >
            {STR.onGitHub}
          </a>
        )}
      </header>
      <div ref={bodyRef} className="relnotes__body" tabIndex={0}>
        {entry.body ? (
          <ReleaseNotesMarkdown markdown={entry.body} />
        ) : (
          <p className="relnotes__none">{STR.noBody}</p>
        )}
      </div>
    </section>
  );
}
