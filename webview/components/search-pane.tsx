import { useEffect, useRef, useState } from 'react';
import { isStaleResponse, type SearchFileResult, type SearchQuery } from '../../src/content-search';
import { post, subscribe } from '../bridge';
import { IconChevronDown, IconSearch } from '../icons';
import { highlightSegments } from '../search-highlight';
import { EmptyState } from './empty-state';

/** Imperative handle so the parent (right-pane) can focus the query input on Mod+Shift+F. */
export interface SearchPaneHandle {
  focusInput(): void;
  /** Clear the query (and results), switching the Files tab back to the tree view. */
  clear(): void;
}

const DEBOUNCE_MS = 180;

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
  onOpenMatch: (abs: string, line: number, column: number) => void;
  onOpenFile: (abs: string) => void;
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
        title={result.rel}
      >
        <IconChevronDown
          size={12}
          className={`searchgroup__chev ${collapsed ? 'searchgroup__chev--collapsed' : ''}${
            nameOnly ? ' searchgroup__chev--hidden' : ''
          }`}
        />
        <span className="searchgroup__file">
          <Hilite text={file} query={query} />
        </span>
        {dir && (
          <span className="searchgroup__dir">
            <Hilite text={dir} query={query} />
          </span>
        )}
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

/**
 * Project-wide content search panel (L5). Owns the query + toggles + glob filters, drives
 * the bounded host search IPC (debounced, superseded by requestId), and renders grouped,
 * highlighted matches. When embedded in the Files tab, `onTextChange` lets the parent
 * switch between the file tree and the results. Read-only navigation v1 (no replace).
 */
export function SearchPane({
  projectPath,
  onOpenMatch,
  paneRef,
  onTextChange,
  hideResultsWhenEmpty,
}: {
  projectPath: string | undefined;
  onOpenMatch: (abs: string, line: number, column: number) => void;
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

  const [results, setResults] = useState<SearchFileResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const [didSearch, setDidSearch] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic request id: a newer query supersedes any older in-flight reply.
  const reqIdRef = useRef(0);
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
    };
    return () => {
      if (paneRef) paneRef.current = null;
    };
  }, [paneRef]);

  // Subscribe to host replies; drop a stale one whose requestId isn't the latest issued.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'contentSearchResults') return;
      if (isStaleResponse(msg.requestId, reqIdRef.current)) return;
      setResults(msg.results);
      setTruncated(msg.truncated);
      setError(msg.error);
      setSearching(false);
    });
  }, []);

  // Debounced query dispatch. Empty query clears results without a host round-trip.
  useEffect(() => {
    if (!projectPath || text.trim() === '') {
      setResults([]);
      setError(undefined);
      setTruncated(false);
      setDidSearch(false);
      setSearching(false);
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
    setSearching(true);
    setDidSearch(true);
    const id = setTimeout(() => {
      const requestId = ++reqIdRef.current;
      post({ type: 'contentSearch', requestId, root: projectPath, query });
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [projectPath, text, matchCase, wholeWord, regex, include, exclude]);

  // Count a name-only hit (no content matches) as one result so the summary reads
  // sensibly (e.g. "3 results in 3 files") when the query matched file/folder names.
  const totalMatches = results.reduce((n, f) => n + (f.matches.length || 1), 0);
  const query: SearchQuery = { text, matchCase, wholeWord, regex };
  const searchIsActive = didSearch;

  const rootClass = hideResultsWhenEmpty
    ? `search search--embedded${searchIsActive ? ' search--active' : ''}`
    : 'search';

  return (
    <div className={rootClass}>
      <div className="search__bar">
        <div className="searchbox search__inputbox">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Search in files"
            onChange={(e) => {
              setText(e.target.value);
              onTextChangeRef.current?.(e.target.value);
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
      ) : !projectPath || (hideResultsWhenEmpty && !didSearch) ? null : !didSearch ? (
        <EmptyState title="Type to search across the project." icon={<IconSearch size={20} />} />
      ) : searching && results.length === 0 ? (
        <EmptyState title="Searching…" role="status" />
      ) : results.length === 0 ? (
        <EmptyState title="No results" hint={`Nothing matches "${text}".`} />
      ) : (
        <>
          <div className="search__summary">
            {totalMatches} {totalMatches === 1 ? 'result' : 'results'} in {results.length}{' '}
            {results.length === 1 ? 'file' : 'files'}
            {truncated && <span className="search__truncated"> · partial (limit reached)</span>}
          </div>
          <div className="right__scroll search__results">
            {results.map((r) => (
              <FileGroup
                key={r.abs}
                result={r}
                query={query}
                onOpenMatch={onOpenMatch}
                onOpenFile={(abs) => onOpenMatch(abs, 1, 1)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
