import type { AnchorHTMLAttributes } from 'react';
import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github-dark.css';
import type { FileContentDTO } from '../../src/protocol';
import { openExternal } from '../bridge';
import { shouldOpenExternally } from '../links';
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

const markdownComponents: Components = { a: MarkdownLink };

export function MarkdownViewer({ doc }: { doc: FileContentDTO }) {
  const [source, setSource] = useState(false);

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
