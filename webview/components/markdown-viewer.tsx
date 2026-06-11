import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github-dark.css';
import type { FileContentDTO } from '../../src/protocol';
import { CodeViewer } from './code-viewer';

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
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {doc.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
