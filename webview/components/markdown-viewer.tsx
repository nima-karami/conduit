import type { AnchorHTMLAttributes, ReactNode } from 'react';
import React, { useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github-dark.css';
import type { FileContentDTO } from '../../src/protocol';
import { openExternal } from '../bridge';
import { resolveMdLink } from '../md-links';
import { SlugFactory } from '../slugify';
import { CodeViewer } from './code-viewer';

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
    // Always prevent default navigation (the webview must never navigate away).
    e.preventDefault();

    switch (result.kind) {
      case 'anchor': {
        // Scroll the in-document heading into view.
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
          // After the file opens, scroll to the fragment (heading) if present.
          if (result.fragment) {
            // The fragment scroll happens after the new doc renders, so we use a
            // short timeout. This is best-effort (cheap to implement, nice to have).
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
        // Inert — tooltip only, no action.
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

// Copy button for code blocks
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

  // Hide if clipboard API is unavailable
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

// Wrapper for code blocks to add copy button
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

// Heading anchor link
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

// Factory to create heading components that use a shared slug factory
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

// Helper to extract text from React children
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
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {doc.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
