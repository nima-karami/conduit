import type { AnchorHTMLAttributes, ReactNode } from 'react';
import React, { useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github-dark.css';
import type { FileContentDTO } from '../../src/protocol';
import { openExternal } from '../bridge';
import { shouldOpenExternally } from '../links';
import { SlugFactory } from '../slugify';
import { CodeViewer } from './code-viewer';

// Open external links in the user's real browser via the host bridge instead of
// navigating the whole app window (wishlist E4 — a chrome-less full-screen page
// with no way back). In the plain-browser preview the bridge is absent, so we
// fall back to a normal new-tab anchor rather than a destructive navigation.
function MarkdownLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const url = href ?? '';
  const external = shouldOpenExternally(url);
  return (
    <a
      {...rest}
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (external && openExternal(url)) e.preventDefault();
      }}
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

function createMarkdownComponents(slugFactory: SlugFactory): Components {
  return {
    a: MarkdownLink,
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

export function MarkdownViewer({ doc }: { doc: FileContentDTO }) {
  const [source, setSource] = useState(false);
  const slugFactory = useMemo(() => new SlugFactory(), []);
  const markdownComponents = useMemo(() => createMarkdownComponents(slugFactory), [slugFactory]);

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
