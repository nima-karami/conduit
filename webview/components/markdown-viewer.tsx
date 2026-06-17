import type { AnchorHTMLAttributes, ReactNode } from 'react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github-dark.css';
import type { FileContentDTO } from '../../src/protocol';
import { openExternal } from '../bridge';
import { IconCopy } from '../icons';
import { buildMarkdownMenuItems } from '../markdown-menu';
import { resolveMdLink } from '../md-links';
import { findBlockForLine, rehypeSourceLine } from '../md-reveal';
import { subscribeReveal, takeReveal } from '../project-index';
import { SlugFactory } from '../slugify';
import { CodeViewer } from './code-viewer';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { isMermaidCodeBlock, MermaidDiagram } from './mermaid-diagram';

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

function createHeadingComponent(Tag: 'h1' | 'h2' | 'h3' | 'h4', slugFactory: SlugFactory) {
  return function HeadingComponent({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) {
    const text = extractTextFromChildren(children);
    const id = slugFactory.slug(text);
    return React.createElement(Tag, { id, ...rest }, <HeadingAnchor id={id} />, children);
  };
}

function extractTextFromChildren(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    return children.map(extractTextFromChildren).join('');
  }
  if (children && typeof children === 'object' && 'props' in children) {
    return extractTextFromChildren(children.props.children);
  }
  return '';
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
  slugFactory: SlugFactory,
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
    h1: createHeadingComponent('h1', slugFactory) as any,
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    h2: createHeadingComponent('h2', slugFactory) as any,
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    h3: createHeadingComponent('h3', slugFactory) as any,
    // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is strict
    h4: createHeadingComponent('h4', slugFactory) as any,
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
  const slugFactory = useMemo(() => new SlugFactory(), []);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(slugFactory, doc.path, onOpenFile),
    [slugFactory, doc.path, onOpenFile],
  );
  const mdRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

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
        <CodeViewer doc={doc} />
      </div>
    );
  }

  return (
    <div className="viewer">
      <button className="viewer__toggle" onClick={() => setSource(true)}>
        View source
      </button>
      <div className="markdown" ref={mdRef} onContextMenu={openMarkdownMenu}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSourceLine, rehypeHighlight]}
          components={markdownComponents}
        >
          {doc.content}
        </ReactMarkdown>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
