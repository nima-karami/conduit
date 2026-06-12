import { useEffect, useRef, useState } from 'react';
import { isStaleResponse, type SearchFileResult, type SearchQuery } from '../../src/content-search';
import { post, subscribe } from '../bridge';
import { IconChevronDown, IconSearch } from '../icons';
import { highlightSegments } from '../search-highlight';

/** Imperative handle so the parent (right-pane) can focus the query input on Mod+Shift+F. */
export interface SearchPaneHandle {
  focusInput(): void;
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

function FileGroup({
  result,
  query,
  onOpenMatch,
}: {
  result: SearchFileResult;
  query: SearchQuery;
  onOpenMatch: (abs: string, line: number, column: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { dir, file } = basename(result.rel);
  return (
    <div className="searchgroup">
      <button
        type="button"
        className="searchgroup__head"
        onClick={() => setCollapsed((c) => !c)}
        title={result.rel}
      >
        <IconChevronDown
          size={12}
          className={`searchgroup__chev ${collapsed ? 'searchgroup__chev--collapsed' : ''}`}
        />
        <span className="searchgroup__file">{file}</span>
        {dir && <span className="searchgroup__dir">{dir}</span>}
        <span className="searchgroup__count">{result.matches.length}</span>
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
              {highlightSegments(m.lineText, query).map((seg, i) =>
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
            </span>
          </button>
        ))}
    </div>
  );
}

/**
 * Project-wide content search panel (L5). Owns the query + toggles + glob filters, drives
 * the bounded host search IPC (debounced, superseded by requestId), and renders grouped,
 * highlighted matches. Clicking a match opens the file at line/col via `onOpenMatch`.
 *
 * Degrades in the browser preview: the bridge mock runs the same pure core over an
 * in-memory corpus, so the panel is fully drivable without a host (window.agentDeck absent).
 *
 * DEFERRED (v1): no replace-in-files. This panel is read-only navigation — find a match,
 * jump to it, edit in the editor. A future replace would add a replace field + per-match /
 * per-file / all apply actions backed by a host-side bounded write IPC (reusing the pure
 * matcher here to compute spans). The pure core (src/content-search) already exposes match
 * columns/lengths, so that engine is the seam a replace feature would build on. Likewise the
 * center pane's planned in-file search can reuse src/content-search's `buildMatcher` for its
 * line scanning rather than a second matcher.
 */
export function SearchPane({
  projectPath,
  onOpenMatch,
  paneRef,
}: {
  projectPath: string | undefined;
  onOpenMatch: (abs: string, line: number, column: number) => void;
  paneRef?: React.MutableRefObject<SearchPaneHandle | null>;
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

  useEffect(() => {
    if (!paneRef) return;
    paneRef.current = {
      focusInput() {
        inputRef.current?.focus();
        inputRef.current?.select();
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

  const totalMatches = results.reduce((n, f) => n + f.matches.length, 0);
  const query: SearchQuery = { text, matchCase, wholeWord, regex };

  return (
    <div className="search">
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
            onChange={(e) => setText(e.target.value)}
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
      ) : !projectPath ? (
        <div className="right__empty">No active project</div>
      ) : !didSearch ? (
        <div className="right__empty">Type to search across the project.</div>
      ) : searching && results.length === 0 ? (
        <div className="right__empty">Searching…</div>
      ) : results.length === 0 ? (
        <div className="right__empty">No results</div>
      ) : (
        <>
          <div className="search__summary">
            {totalMatches} {totalMatches === 1 ? 'result' : 'results'} in {results.length}{' '}
            {results.length === 1 ? 'file' : 'files'}
            {truncated && <span className="search__truncated"> · partial (limit reached)</span>}
          </div>
          <div className="right__scroll search__results">
            {results.map((r) => (
              <FileGroup key={r.abs} result={r} query={query} onOpenMatch={onOpenMatch} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
