import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  noResultsMessage,
  type SearchFileResult,
  type SearchQuery,
} from '../../src/content-search';
import {
  acceptFolderReply,
  IDLE_SEARCH,
  isSearching,
  type MultiSearchState,
  multiSearchSummary,
  retainFolders,
  type SearchFolderGroup,
  searchableFolders,
  searchFolderGroups,
  startMultiSearch,
  timeOutSearch,
} from '../../src/folder-search';
import type { FolderSectionModel } from '../../src/session-sections';
import { post, subscribe } from '../bridge';
import type { OpenMode } from '../docs';
import { stampFileDrag } from '../file-drag-data';
import { IconChevronDown, IconSearch } from '../icons';
import { middleClickProps } from '../middle-click';
import { highlightSegments } from '../search-highlight';
import { EmptyState } from './empty-state';

/** Imperative handle so the parent (right-pane) can focus the query input on Mod+Shift+F. */
export interface SearchPaneHandle {
  focusInput(): void;
  /** Clear the query (and results), switching the Files tab back to the tree view. */
  clear(): void;
  /** Replace the query with `next`, run it, and focus + select-all so typing replaces the
   *  seed. Used to seed the box from the editor selection (Mod+Shift+F). */
  setQuery(next: string): void;
}

const DEBOUNCE_MS = 180;
// If the host never replies to a contentSearch (crash / stuck walk), clear the
// spinner and surface an error instead of spinning forever.
const SEARCH_TIMEOUT_MS = 15000;
const TIMED_OUT = 'Search timed out. Try again.';

function basename(rel: string): { dir: string; file: string } {
  const i = rel.lastIndexOf('/');
  return i < 0 ? { dir: '', file: rel } : { dir: rel.slice(0, i), file: rel.slice(i + 1) };
}

function ToggleBtn({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`search__toggle ${active ? 'search__toggle--on' : ''}`}
      title={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Render `text` with the query's matches wrapped in <mark>, re-running the matcher
 * client-side (see highlightSegments). Used for match lines AND file/folder names. */
function Hilite({ text, query }: { text: string; query: SearchQuery }) {
  return (
    <>
      {highlightSegments(text, query).map((seg, i) =>
        seg.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional + stable per render
          <mark key={i} className="searchmatch__hit">
            {seg.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional + stable per render
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function FileGroup({
  result,
  query,
  onOpenMatch,
  onOpenFile,
}: {
  result: SearchFileResult;
  query: SearchQuery;
  onOpenMatch: (abs: string, line: number, column: number, mode?: OpenMode) => void;
  onOpenFile: (abs: string, mode?: OpenMode) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { dir, file } = basename(result.rel);
  // A name-only hit (path matched, no content matches) isn't expandable — clicking the
  // header opens the file rather than collapsing an empty match list.
  const nameOnly = result.matches.length === 0;
  return (
    <div className="searchgroup">
      <button
        type="button"
        className="searchgroup__head"
        onClick={() => (nameOnly ? onOpenFile(result.abs) : setCollapsed((c) => !c))}
        {...middleClickProps(nameOnly ? () => onOpenFile(result.abs, 'background') : null)}
        title={result.rel}
        draggable
        onDragStart={(e) => {
          stampFileDrag(e.dataTransfer, result.abs, { download: true, terminal: true });
          e.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <IconChevronDown
          size={12}
          className={`searchgroup__chev ${collapsed ? 'searchgroup__chev--collapsed' : ''}${
            nameOnly ? ' searchgroup__chev--hidden' : ''
          }`}
        />
        <span className="searchgroup__path">
          <span className="searchgroup__file">
            <Hilite text={file} query={query} />
          </span>
          {dir && (
            <span className="searchgroup__dir">
              <Hilite text={dir} query={query} />
            </span>
          )}
        </span>
        {nameOnly ? (
          <span className="searchgroup__namebadge" title="Matched the file/folder name">
            name
          </span>
        ) : (
          <span className="searchgroup__count">{result.matches.length}</span>
        )}
      </button>
      {!collapsed &&
        result.matches.map((m) => (
          <button
            type="button"
            key={`${m.line}:${m.column}`}
            className="searchmatch"
            title={`Open ${result.rel}:${m.line}`}
            onClick={() => onOpenMatch(result.abs, m.line, m.column)}
            {...middleClickProps(() => onOpenMatch(result.abs, m.line, m.column, 'background'))}
          >
            <span className="searchmatch__line">{m.line}</span>
            <span className="searchmatch__text">
              <Hilite text={m.lineText} query={query} />
            </span>
          </button>
        ))}
    </div>
  );
}

/** More than one folder: a heading per folder (folder order), today's file groups inside. */
function FolderGroups({
  groups,
  labelOf,
  query,
  onOpenMatch,
}: {
  groups: readonly SearchFolderGroup[];
  labelOf: (key: string) => string;
  query: SearchQuery;
  onOpenMatch: (abs: string, line: number, column: number, mode?: OpenMode) => void;
}) {
  const hasResults = groups.some((g) => g.results.length > 0);
  return (
    <>
      {hasResults && <div className="search__summary">{multiSearchSummary(groups)}</div>}
      <div className="rightpane__scroll search__results">
        {groups.map((g) => (
          <div className="searchfolder" key={g.key}>
            <div className="searchfolder__head" role="heading" aria-level={3}>
              <bdi className="searchfolder__name" dir="auto">
                {labelOf(g.key)}
              </bdi>
              {g.resultCount > 0 && <span className="searchfolder__count">{g.resultCount}</span>}
            </div>
            {g.note && <div className="searchfolder__note">{g.note}</div>}
            {g.results.map((r) => (
              <FileGroup
                key={r.abs}
                result={r}
                query={query}
                onOpenMatch={onOpenMatch}
                onOpenFile={(abs, mode) => onOpenMatch(abs, 1, 1, mode)}
              />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Project-wide content search panel (L5). Owns the query + toggles + glob filters, drives
 * the bounded host search IPC (debounced, superseded by requestId), and renders grouped,
 * highlighted matches. When embedded in the Files tab, `onTextChange` lets the parent
 * switch between the file tree and the results. Read-only navigation v1 (no replace).
 */
export function SearchPane({
  folders,
  onOpenMatch,
  paneRef,
  onTextChange,
  hideResultsWhenEmpty,
}: {
  /** The session's folders; only the present ones are searched (L9). */
  folders: readonly FolderSectionModel[];
  onOpenMatch: (abs: string, line: number, column: number, mode?: OpenMode) => void;
  paneRef?: React.MutableRefObject<SearchPaneHandle | null>;
  /** Called whenever the raw query text changes (including empty). Used by the Files tab
   *  to switch between the file tree and search results view. */
  onTextChange?: (text: string) => void;
  /** When true, suppress the empty-state hint below the bar when there's no query.
   *  Used by the Files tab so the search bar is compact and the tree shows below. */
  hideResultsWhenEmpty?: boolean;
}) {
  const [text, setText] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');

  const present = searchableFolders(folders);
  const folderKeys = present.map((f) => f.key).join('\n');
  const [search, setSearch] = useState<MultiSearchState>(IDLE_SEARCH);
  // Between a keystroke and its debounced dispatch the previous results stay up, still busy.
  const [pending, setPending] = useState(false);
  const [didSearch, setDidSearch] = useState(false);
  const presentRef = useRef(present);
  presentRef.current = present;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Monotonic request id: a newer query supersedes any older in-flight reply.
  const reqIdRef = useRef(0);
  // Watchdog for the in-flight request, so a host that never replies can't strand
  // the spinner. Cleared when its reply lands; superseded when a newer query starts.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // In a ref so the effects below don't carry it as a dep (avoids exhaustive-deps churn).
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;

  useEffect(() => {
    if (!paneRef) return;
    paneRef.current = {
      focusInput() {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
      clear() {
        setText(''); // empties results via the debounce effect; notifies the Files tab
        onTextChangeRef.current?.('');
      },
      setQuery(next) {
        // select() reads the DOM, so the new value has to be committed before it runs —
        // otherwise it selects the previous query and React's update collapses it.
        flushSync(() => setText(next));
        onTextChangeRef.current?.(next); // REQUIRED: the Files tab stays on the tree without it
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    };
    return () => {
      if (paneRef) paneRef.current = null;
    };
  }, [paneRef]);

  // Auto-grow the field to its content. Keyed on `text` rather than wired into onChange so
  // every path that sets the query — typing, setQuery's seed, clear()'s reset — resizes from
  // one rule. Layout effect, so a seeded multi-line query is never painted at one row first.
  // The row cap is CSS's (.searchbox textarea max-height), which clamps the inline height
  // set here; repeating the number in JS would be a second source of truth for it.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (text === '') {
      el.style.height = ''; // back to the rows={1} default rather than a computed one-row px
      return;
    }
    // Collapse first, or scrollHeight can only ever report the height it already has.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Clear the watchdog if the pane unmounts mid-flight.
  useEffect(
    () => () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    },
    [],
  );

  // Host replies, one per folder: a stale requestId or a folder no longer expected is dropped
  // by the reducer (it returns the same state).
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'contentSearchResults') return;
      setSearch((s) => acceptFolderReply(s, msg));
    });
  }, []);
  // Every folder answered: the watchdog has nothing left to guard.
  useEffect(() => {
    if (!isSearching(search) && watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, [search]);
  // A folder that left the session mid-flight stops being waited for (spec §4).
  useEffect(() => {
    const keys = folderKeys === '' ? [] : folderKeys.split('\n');
    setSearch((s) => retainFolders(s, keys));
  }, [folderKeys]);

  // Debounced query dispatch. Empty query clears results without a host round-trip.
  useEffect(() => {
    if (folderKeys === '' || text.trim() === '') {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      setSearch(IDLE_SEARCH);
      setDidSearch(false);
      setPending(false);
      return;
    }
    const query: SearchQuery = {
      text,
      matchCase,
      wholeWord,
      regex,
      include: include.trim() || undefined,
      exclude: exclude.trim() || undefined,
    };
    setPending(true);
    setDidSearch(true);
    const id = setTimeout(() => {
      // One requestId for every folder (D11); the host cancels per root, so siblings never
      // supersede each other.
      const requestId = ++reqIdRef.current;
      const targets = presentRef.current;
      setSearch(
        startMultiSearch(
          requestId,
          targets.map((f) => f.key),
        ),
      );
      setPending(false);
      for (const f of targets) post({ type: 'contentSearch', requestId, root: f.path, query });
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        setSearch((s) => (s.requestId === requestId ? timeOutSearch(s) : s));
      }, SEARCH_TIMEOUT_MS);
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [folderKeys, text, matchCase, wholeWord, regex, include, exclude]);

  const busy = pending || isSearching(search);
  const groups = searchFolderGroups(search);
  const single = present.length === 1;
  // One folder renders exactly as before mf-files, fed from that folder's own reply.
  const only = single ? search.replies[present[0].key] : undefined;
  const results: SearchFileResult[] = single
    ? (only?.results ?? [])
    : groups.flatMap((g) => g.results);
  const truncated = single ? (only?.truncated ?? false) : false;
  const error = single
    ? (only?.error ?? (search.timedOut && !only ? TIMED_OUT : undefined))
    : undefined;
  // Count a name-only hit (no content matches) as one result so the summary reads
  // sensibly (e.g. "3 results in 3 files") when the query matched file/folder names.
  const totalMatches = results.reduce((n, f) => n + (f.matches.length || 1), 0);
  const query: SearchQuery = { text, matchCase, wholeWord, regex };
  const searchIsActive = didSearch;
  const labelOf = (key: string) => present.find((f) => f.key === key)?.label ?? key;

  const rootClass = hideResultsWhenEmpty
    ? `search search--embedded${searchIsActive ? ' search--active' : ''}`
    : 'search';

  return (
    <div className={rootClass}>
      <div className="search__bar">
        <div className="searchbox search__inputbox">
          <IconSearch size={14} />
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Search in files"
            onChange={(e) => {
              setText(e.target.value);
              onTextChangeRef.current?.(e.target.value);
            }}
            onKeyDown={(e) => {
              // VS Code's contract: Shift+Enter inserts a newline, a bare Enter does not —
              // and has nothing else to do here, since the query is already debounced.
              if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
            }}
          />
          <div className="search__toggles">
            <ToggleBtn
              label="Aa"
              title="Match case"
              active={matchCase}
              onClick={() => setMatchCase((v) => !v)}
            />
            <ToggleBtn
              label="W"
              title="Whole word"
              active={wholeWord}
              onClick={() => setWholeWord((v) => !v)}
            />
            <ToggleBtn
              label=".*"
              title="Use regular expression"
              active={regex}
              onClick={() => setRegex((v) => !v)}
            />
          </div>
        </div>
        <button
          type="button"
          className={`search__filterstoggle ${showFilters ? 'search__filterstoggle--on' : ''}`}
          title="Toggle include/exclude filters"
          aria-pressed={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          <IconChevronDown size={13} />
        </button>
      </div>
      {showFilters && (
        <div className="search__filters">
          <input
            className="search__glob"
            value={include}
            spellCheck={false}
            placeholder="files to include (e.g. *.ts, src/*)"
            onChange={(e) => setInclude(e.target.value)}
          />
          <input
            className="search__glob"
            value={exclude}
            spellCheck={false}
            placeholder="files to exclude (e.g. *test*)"
            onChange={(e) => setExclude(e.target.value)}
          />
        </div>
      )}

      {error ? (
        <div className="search__error" role="alert">
          {error}
        </div>
      ) : present.length === 0 || (hideResultsWhenEmpty && !didSearch) ? null : !didSearch ? (
        <EmptyState title="Type to search across the project." icon={<IconSearch size={20} />} />
      ) : busy && results.length === 0 ? (
        <EmptyState title="Searching…" role="status" />
      ) : !single && groups.length > 0 ? (
        <FolderGroups groups={groups} labelOf={labelOf} query={query} onOpenMatch={onOpenMatch} />
      ) : results.length === 0 ? (
        <EmptyState {...noResultsMessage(text, truncated)} />
      ) : (
        <>
          <div className="search__summary">
            {totalMatches} {totalMatches === 1 ? 'result' : 'results'} in {results.length}{' '}
            {results.length === 1 ? 'file' : 'files'}
            {truncated && <span className="search__truncated"> · partial (limit reached)</span>}
          </div>
          <div className="rightpane__scroll search__results">
            {results.map((r) => (
              <FileGroup
                key={r.abs}
                result={r}
                query={query}
                onOpenMatch={onOpenMatch}
                onOpenFile={(abs, mode) => onOpenMatch(abs, 1, 1, mode)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
