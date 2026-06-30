import type { AnchorHTMLAttributes, ReactNode } from 'react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
import type { FileContentDTO } from '../../src/protocol';
import { openExternal } from '../bridge';
import { IconCopy } from '../icons';
import { buildMarkdownMenuItems } from '../markdown-menu';
import { remarkAlerts } from '../md-alerts';
import { remarkFrontmatterCard } from '../md-frontmatter';
import { resolveMdLink } from '../md-links';
import { findBlockForLine, rehypeHeadingIds, rehypeSourceLine } from '../md-reveal';
import { markdownSanitizeSchema } from '../md-sanitize';
import { buildTocEntries, type HeadingInfo, pickActiveIndex, TOC_MIN_HEADINGS } from '../md-toc';
import { hasReveal, subscribeReveal, takeReveal } from '../project-index';
import { makeDebouncedFlush } from '../use-debounced-flush';
import {
  clampScrollTop,
  getViewState,
  setViewState,
  VIEW_STATE_DEBOUNCE_MS,
} from '../view-state-store';
import { CodeViewer } from './code-viewer';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { MarkdownToc } from './markdown-toc';
import { isMermaidCodeBlock, MermaidDiagram } from './mermaid-diagram';

// Hoisted to module scope so the unified pipeline isn't handed fresh array identities on every
// render — a new plugin-list reference re-parses/re-sanitizes/re-highlights the whole doc (the
// same reason markdownComponents is memoized below). All plugins + the schema are static.
const REMARK_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [
  remarkFrontmatter,
  remarkGfm,
  remarkMath,
  remarkAlerts,
  remarkFrontmatterCard,
];
// rehypeRaw parses embedded HTML into the tree; rehypeSanitize then strips anything dangerous
// BEFORE our trusted plugins (highlight/katex/ids) enrich it, so their output is never
// re-sanitized. See md-sanitize.ts for the schema.
const REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeHeadingIds,
  rehypeSourceLine,
  rehypeHighlight,
  rehypeKatex,
];

/**
 * Handles all link kinds in the rendered markdown view (anchor, relative/absolute
 * file, external, other). Navigation away from the webview is ALWAYS prevented.
 */
function MarkdownLink({
  href,
  children,
  docPath,
  onOpenFile,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  docPath: string;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const result = useMemo(() => resolveMdLink(href, docPath), [href, docPath]);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    switch (result.kind) {
      case 'anchor': {
        const id = result.fragment ?? '';
        if (id) {
          const el = document.getElementById(id);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        break;
      }

      case 'relative-file':
      case 'absolute-file': {
        const path = result.resolvedPath;
        if (path && onOpenFile) {
          onOpenFile(path);
          if (result.fragment) {
            // Best-effort: scroll once the new doc has had time to render.
            const frag = result.fragment;
            setTimeout(() => {
              const el = document.getElementById(frag);
              el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 200);
          }
        }
        break;
      }

      case 'external': {
        const url = href ?? '';
        // openExternal returns false in the preview; fall back to a new tab.
        if (!openExternal(url)) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        break;
      }

      case 'other':
        break;
    }
  };

  // File links omit href (avoids the browser's default underline; we style via CSS).
  const isUnsupported = result.kind === 'other';
  const isFile = result.kind === 'relative-file' || result.kind === 'absolute-file';

  return (
    <a
      {...rest}
      href={isFile ? undefined : (href ?? '')}
      title={isUnsupported ? 'Unsupported link type' : rest.title}
      style={{ cursor: isUnsupported ? 'default' : 'pointer', ...rest.style }}
      onClick={handleClick}
      rel={result.kind === 'external' ? 'noreferrer' : undefined}
    >
      {children}
    </a>
  );
}

function CodeBlockCopyButton({ pre }: { pre: HTMLPreElement }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      const text = pre.textContent || '';
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (!navigator.clipboard) {
    return null;
  }

  return (
    <button
      className={`markdown-code-copy-btn ${copied ? 'copied' : ''}`}
      onClick={handleCopy}
      type="button"
      aria-label="Copy code block"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlockWrapper({ children }: { children: ReactNode }) {
  const [pre, setPre] = useState<HTMLPreElement | null>(null);

  return (
    <div
      ref={(el) => {
        if (el && !pre) {
          const preEl = el.querySelector('pre');
          if (preEl) setPre(preEl);
        }
      }}
      style={{ position: 'relative' }}
    >
      {pre && <CodeBlockCopyButton pre={pre} />}
      {children}
    </div>
  );
}

/** Serialize the current selection's DOM fragment to an HTML string. */
function selectionToHtml(sel: Selection): string {
  const holder = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) {
    holder.appendChild(sel.getRangeAt(i).cloneContents());
  }
  return holder.innerHTML;
}

/**
 * Copy the selection as BOTH text/html and text/plain (like native Ctrl+C) so pasting
 * into a rich editor keeps the rendered formatting. Falls back to plain text where
 * `clipboard.write`/ClipboardItem is unavailable.
 */
async function copyRichSelection(): Promise<void> {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const html = selectionToHtml(sel);
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
    }
  } catch {
    // fall through to plain-text copy
  }
  await navigator.clipboard?.writeText(text);
}

function HeadingAnchor({ id }: { id: string }) {
  // The visible "#" is a CSS ::before pseudo-element, not a text node, so Select All /
  // copy never picks it up. The anchor stays empty; aria-label carries the name.
  return (
    <a
      className="markdown-heading-anchor"
      href={`#${id}`}
      aria-label={`Link to ${id}`}
      tabIndex={0}
    />
  );
}

function createHeadingComponent(Tag: 'h1' | 'h2' | 'h3' | 'h4') {
  // `id` is stamped on the heading by rehypeHeadingIds (stable across re-renders) and
  // arrives here as a prop; the anchor reuses it. Omit the anchor for an id-less
  // heading (empty text).
  return function HeadingComponent({
    id,
    children,
    ...rest
  }: {
    id?: string;
    children?: ReactNode;
    [key: string]: unknown;
  }) {
    return React.createElement(
      Tag,
      { id, ...rest },
      id ? <HeadingAnchor id={id} /> : null,
      children,
    );
  };
}

/**
 * react-markdown `a` override bound to the doc path and file opener. A named factory so
 * the call site stays typed without an `as any`.
 */
// biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
function makeMarkdownLink(docPath: string, onOpenFile: ((path: string) => void) | undefined): any {
  return function BoundMarkdownLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
    return <MarkdownLink {...props} docPath={docPath} onOpenFile={onOpenFile} />;
  };
}

function createMarkdownComponents(
  docPath: string,
  onOpenFile: ((path: string) => void) | undefined,
): Components {
  return {
    a: makeMarkdownLink(docPath, onOpenFile),
    pre: ({ children, ...props }) => (
      <CodeBlockWrapper>
        <pre {...props}>{children}</pre>
      </CodeBlockWrapper>
    ),
    // Mermaid fences render as a diagram; all other languages pass through to rehype-highlight.
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    code: ({ className, children, ...props }: any) => {
      if (isMermaidCodeBlock(className)) {
        const source = String(children ?? '').replace(/\n$/, '');
        return <MermaidDiagram source={source} />;
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    h1: createHeadingComponent('h1') as any,
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    h2: createHeadingComponent('h2') as any,
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    h3: createHeadingComponent('h3') as any,
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    h4: createHeadingComponent('h4') as any,
  };
}

// Duration (ms) the flash highlight stays visible. Must match CSS animation length.
const FLASH_DURATION_MS = 1200;

/** Flash class applied to the target block element and removed after the animation. */
const FLASH_CLASS = 'markdown__block--flash';

/**
 * Scroll the rendered markdown to the target line for a staged reveal: find the nearest
 * block via `data-source-line`, center it, and flash it.
 */
function revealLineInMarkdown(container: HTMLDivElement, targetLine: number): void {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]'));
  if (nodes.length === 0) return;

  const blocks = nodes.map((el) => ({
    sourceLine: Number(el.getAttribute('data-source-line')),
  }));

  const idx = findBlockForLine(blocks, targetLine);
  if (idx < 0) return;

  const target = nodes[idx];
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  target.classList.add(FLASH_CLASS);
  setTimeout(() => {
    target.classList.remove(FLASH_CLASS);
  }, FLASH_DURATION_MS);
}

export function MarkdownViewer({
  doc,
  onOpenFile,
}: {
  doc: FileContentDTO;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const [source, setSource] = useState(false);
  // Route the file-opener through a ref so a new `onOpenFile` identity (it changes on
  // every session add/switch in the parent) doesn't rebuild markdownComponents and
  // force a full ReactMarkdown re-parse. The wrapper is stable; components depend only
  // on doc.path.
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const openFileStable = useCallback((path: string) => onOpenFileRef.current?.(path), []);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(doc.path, openFileStable),
    [doc.path, openFileStable],
  );
  const mdRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [tocEntries, setTocEntries] = useState<ReturnType<typeof buildTocEntries>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // An explicit outline click wins over scroll-spy: while pinned, scroll-spy yields, so the
  // jump's smooth-scroll doesn't repaint the active entry as it animates, and a click on one
  // of several short trailing sections (which share a bottomed-out scroll position scroll-spy
  // can't tell apart) sticks. Released on the next genuine user scroll; cleared on a doc
  // change. The passive case — wheeling to the bottom with no pin — is handled by
  // pickActiveIndex's bottom-snap, not here.
  const pinnedIdRef = useRef<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);

  // Scrape headings from the rendered output (reusing the slug ids the heading
  // components already stamp) to build the outline. rAF so ReactMarkdown has painted.
  // Re-runs when the rendered content changes (doc.content) or the view toggles.
  useEffect(() => {
    const container = mdRef.current;
    if (source || !doc.content || !container) {
      setTocEntries([]);
      setActiveId(null);
      return;
    }
    pinnedIdRef.current = null;
    const raf = requestAnimationFrame(() => {
      const els = Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4'));
      const headings: HeadingInfo[] = els
        .filter((el) => el.id)
        .map((el) => ({ level: Number(el.tagName[1]), id: el.id, text: el.textContent ?? '' }));
      setTocEntries(buildTocEntries(headings));
    });
    return () => cancelAnimationFrame(raf);
  }, [doc.content, source]);

  // Scroll-spy: highlight the entry for the section at the top of the viewport.
  useEffect(() => {
    const container = mdRef.current;
    if (source || tocEntries.length === 0 || !container) return;
    // Resolve the heading elements once per heading set (not per scroll frame); their
    // rects are still read live each frame so async layout shifts stay correct.
    const els = tocEntries.map((e) => document.getElementById(e.id));
    let raf = 0;
    const update = () => {
      raf = 0;
      if (pinnedIdRef.current !== null) return;
      const cTop = container.getBoundingClientRect().top;
      const tops = els.map((el) =>
        el ? el.getBoundingClientRect().top - cTop + container.scrollTop : Number.POSITIVE_INFINITY,
      );
      // If no heading resolved (all Infinity) don't fall back to highlighting the
      // first — that would mask a genuine "nothing found" as a plausible-but-wrong
      // active entry.
      if (tops.every((t) => !Number.isFinite(t))) {
        setActiveId(null);
        return;
      }
      const idx = pickActiveIndex(
        tops,
        container.scrollTop,
        80,
        container.scrollHeight,
        container.clientHeight,
      );
      setActiveId(idx >= 0 ? tocEntries[idx].id : null);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    // A real scroll gesture (wheel/touch/scroll-key) releases a click-pin so scroll-spy
    // resumes; the programmatic smooth-scroll from a jump fires none of these.
    const releasePin = () => {
      if (pinnedIdRef.current === null) return;
      pinnedIdRef.current = null;
      if (!raf) raf = requestAnimationFrame(update);
    };
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    const onKeyDown = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) releasePin();
    };
    update();
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', releasePin, { passive: true });
    container.addEventListener('touchstart', releasePin, { passive: true });
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', releasePin);
      container.removeEventListener('touchstart', releasePin);
      container.removeEventListener('keydown', onKeyDown);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [tocEntries, source]);

  const jumpToHeading = useCallback((id: string) => {
    pinnedIdRef.current = id;
    setActiveId(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const tocAvailable = tocEntries.length >= TOC_MIN_HEADINGS;

  // D7 — on-mount reveal: a fresh open stages the reveal BEFORE mount, so subscribeReveal
  // won't fire. The timeout lets ReactMarkdown render (the data-source-line nodes must
  // exist before we query them) before consuming any pending reveal.
  useEffect(() => {
    const id = setTimeout(() => {
      const container = mdRef.current;
      if (!container) return;
      const pos = takeReveal(doc.path);
      if (!pos) return;
      revealLineInMarkdown(container, pos.line);
    }, 50);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path]);

  // D7 — live reveal for an already-mounted viewer (file is already the open tab).
  // Same seam CodeViewer uses for its already-mounted case.
  useEffect(() => {
    return subscribeReveal((path) => {
      const container = mdRef.current;
      if (!container) return;
      const k = doc.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (path !== k) return;
      // take() so CodeViewer doesn't also consume the same reveal.
      const pos = takeReveal(doc.path);
      if (!pos) return;
      revealLineInMarkdown(container, pos.line);
    });
  }, [doc.path]);

  // Per-tab scroll memory (spec 2026-06-30). Restore the rendered scroller pre-paint unless an
  // explicit reveal is staged (reveal wins, §3). Reset the guard when toggling to source so a
  // return to rendered restores again. The window's own reveal effects consume the reveal.
  const restoredPathRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = mdRef.current;
    if (source || !el) {
      restoredPathRef.current = null;
      return;
    }
    if (restoredPathRef.current === doc.path) return;
    restoredPathRef.current = doc.path;
    if (hasReveal(doc.path)) return;
    const saved = getViewState(`file:${doc.path}`);
    if (saved?.kind === 'scroll') {
      el.scrollTop = clampScrollTop(saved.top, el.scrollHeight, el.clientHeight);
    }
  }, [doc.path, source]);

  // Capture scroll (debounced) + a synchronous final capture when the rendered scroller unmounts
  // (tab switch / source toggle), so a fast switch never loses the last position (D5). The final
  // capture reads `last` (updated live on scroll), not the DOM — on unmount the element is already
  // detached and would report scrollTop 0, clobbering the saved offset. `last` is seeded from the
  // restored position so a no-scroll switch re-saves the same value (idempotent).
  useEffect(() => {
    const el = mdRef.current;
    if (source || !el) return;
    const id = `file:${doc.path}`;
    const last = { top: el.scrollTop };
    const capture = () => setViewState(id, { kind: 'scroll', top: last.top });
    const debounced = makeDebouncedFlush(capture, VIEW_STATE_DEBOUNCE_MS);
    const onScroll = () => {
      last.top = el.scrollTop;
      debounced.schedule();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      debounced.cancel();
      capture();
    };
  }, [doc.path, source]);

  // Select only the rendered markdown's contents, not the whole document.
  const selectAllContents = useCallback(() => {
    const el = mdRef.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }, []);

  // Scope Ctrl/Cmd+A to the rendered view (capture phase beats the browser default), but
  // only when this viewer owns the interaction — focus/selection inside it, or nothing
  // focused — so a focused terminal/input keeps its own Select All.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || (e.key !== 'a' && e.key !== 'A')) return;
      const el = mdRef.current;
      if (!el) return;
      const active = document.activeElement;
      const anchor = window.getSelection()?.anchorNode ?? null;
      const owns =
        (active && el.contains(active)) ||
        (anchor && el.contains(anchor)) ||
        active === null ||
        active === document.body;
      if (!owns) return;
      e.preventDefault();
      e.stopPropagation();
      selectAllContents();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [selectAllContents]);

  const openMarkdownMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const hasSelection = !(window.getSelection()?.isCollapsed ?? true);
    const items: MenuItem[] = buildMarkdownMenuItems({ hasSelection }).map((spec) => ({
      label: spec.label,
      icon: spec.action === 'copy' ? <IconCopy size={14} /> : undefined,
      disabled: spec.disabled,
      separatorBefore: spec.separatorBefore,
      onClick: () => {
        if (spec.action === 'copy') {
          void copyRichSelection();
        } else {
          selectAllContents();
        }
      },
    }));
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  if (source) {
    return (
      <div className="viewer">
        <button className="viewer__toggle" onClick={() => setSource(false)}>
          View rendered
        </button>
        <CodeViewer doc={doc} viewStateId={`markdown-source:${doc.path}`} />
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer__controls">
        {tocAvailable && (
          <button
            className="viewer__toggle"
            aria-expanded={tocOpen}
            onClick={() => setTocOpen((v) => !v)}
          >
            Outline
          </button>
        )}
        <button className="viewer__toggle" onClick={() => setSource(true)}>
          View source
        </button>
      </div>
      {tocAvailable && (
        <MarkdownToc
          entries={tocEntries}
          activeId={activeId}
          onJump={jumpToHeading}
          open={tocOpen}
        />
      )}
      <div className="markdown" ref={mdRef} onContextMenu={openMarkdownMenu}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={markdownComponents}
        >
          {doc.content}
        </ReactMarkdown>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
