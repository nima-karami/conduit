import type { AnchorHTMLAttributes, ReactNode } from 'react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
 * MarkdownLink — handles all link kinds in the rendered markdown view.
 *
 * - anchor (#section)    → scrollIntoView on the target element
 * - relative/absolute file → open via onOpenFile (md → rendered view, code → editor)
 * - external (http/https) → open in system browser via bridge; falls back to new tab
 * - other (mailto: etc.) → inert anchor, shows "unsupported link" tooltip
 *
 * Navigation away from the webview is ALWAYS prevented; the webview must not
 * navigate to a new page.
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
            // Best-effort: scroll after the new doc has had time to render.
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
        // Try host bridge first; falls back gracefully (openExternal returns false in preview).
        if (!openExternal(url)) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        break;
      }

      case 'other':
        break;
    }
  };

  // For "other" links show a tooltip; for file links don't set href (no
  // underline default from browser, we style via CSS).
  const isUnsupported = result.kind === 'other';
  const isFile = result.kind === 'relative-file' || result.kind === 'absolute-file';

  return (
    <a
      {...rest}
      href={isFile ? undefined : (href ?? '')}
      title={isUnsupported ? 'Unsupported link type' : rest.title}
      style={{ cursor: isUnsupported ? 'default' : 'pointer', ...rest.style }}
      onClick={handleClick}
      // rel/target only makes sense for external — browser-opened links.
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
      // Silent failure if clipboard is unavailable
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

function HeadingAnchor({ id }: { id: string }) {
  return (
    <a
      className="markdown-heading-anchor"
      href={`#${id}`}
      aria-label={`Link to ${id}`}
      tabIndex={0}
    >
      #
    </a>
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
 * Return a react-markdown `a` component override bound to the given doc path
 * and file opener. Extracted as a named factory so it can be typed correctly
 * without an `as any` at the call site.
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
    // Intercept fenced code blocks: mermaid language → render as a diagram;
    // all other languages pass through to rehype-highlight unchanged.
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
 * Scroll the rendered markdown container to the target line for a staged reveal.
 * Reads `data-source-line` attributes from block-level children to locate the
 * nearest block, then scrolls it into view (centered) and adds the flash class.
 */
function revealLineInMarkdown(container: HTMLDivElement, targetLine: number): void {
  // Collect all block elements that carry a source-line annotation.
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]'));
  if (nodes.length === 0) return;

  const blocks = nodes.map((el) => ({
    sourceLine: Number(el.getAttribute('data-source-line')),
  }));

  const idx = findBlockForLine(blocks, targetLine);
  if (idx < 0) return;

  const target = nodes[idx];
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Flash highlight: add class, remove after animation completes.
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

  // D7 — on-mount reveal: when this viewer is freshly opened for a search hit, the
  // reveal is staged BEFORE mount, so the subscribeReveal below won't fire.  We use
  // a short timeout to let the ReactMarkdown tree finish rendering (DOM nodes with
  // data-source-line must exist before we query them), then consume any pending reveal.
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

  // D7 — live reveal: when this viewer is already mounted (the file is already the
  // open tab) and a new search-hit reveal is staged, consume it immediately.
  // The same seam CodeViewer uses for its already-mounted case.
  useEffect(() => {
    return subscribeReveal((path) => {
      const container = mdRef.current;
      if (!container) return;
      // Only act when the staged reveal targets this document.
      const k = doc.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (path !== k) return;
      // Consume (take) the pending reveal so CodeViewer doesn't also try to use it.
      const pos = takeReveal(doc.path);
      if (!pos) return;
      revealLineInMarkdown(container, pos.line);
    });
  }, [doc.path]);

  // Right-click menu for the rendered (read-only) view: Copy the live selection,
  // or Select All the rendered content. Mirrors the editor/terminal menus.
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
          const text = window.getSelection()?.toString() ?? '';
          if (text) void navigator.clipboard?.writeText(text);
        } else {
          const el = mdRef.current;
          const sel = window.getSelection();
          if (el && sel) {
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
          }
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
