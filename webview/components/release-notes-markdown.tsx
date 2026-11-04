import { type ImgHTMLAttributes, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal } from '../bridge';
import { CHROME_STR } from '../chrome-strings';
import { MARKDOWN_SAFETY_PLUGINS } from '../markdown-safety';
import { remoteImageHost } from '../md-links';
import { middleClickProps } from '../middle-click';

const REMARK_PLUGINS = [remarkGfm];
function ReleaseNoteImage({ src, alt, title }: ImgHTMLAttributes<HTMLImageElement>) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const remoteSrc =
    typeof src === 'string' && /^(?:https?:)?\/\//i.test(src)
      ? src.startsWith('//')
        ? `https:${src}`
        : src
      : null;
  if (remoteSrc && loadedSrc !== remoteSrc) {
    const label = CHROME_STR.update.loadImage(remoteImageHost(remoteSrc), alt);
    return (
      <button
        type="button"
        className="markdown-img-status markdown-img-load"
        title={title}
        aria-label={label}
        onClick={() => setLoadedSrc(remoteSrc)}
      >
        {label}
      </button>
    );
  }
  if (remoteSrc || (typeof src === 'string' && /^data:image\//i.test(src))) {
    return <img src={remoteSrc ?? src} alt={alt ?? ''} title={title} />;
  }
  return (
    <span
      className="markdown-img-status"
      role="img"
      aria-label={alt || CHROME_STR.update.imageUnavailable}
    >
      {alt || CHROME_STR.update.imageUnavailable}
    </span>
  );
}
const COMPONENTS: Components = {
  img: ReleaseNoteImage,
  a: ({ href, children }) => (
    <a
      href={href}
      {...middleClickProps(() => {
        if (href) openExternal(href);
      })}
      onClick={(e) => {
        e.preventDefault();
        if (href) openExternal(href);
      }}
    >
      {children}
    </a>
  ),
};

export function ReleaseNotesMarkdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_SAFETY_PLUGINS}
      components={COMPONENTS}
    >
      {markdown}
    </ReactMarkdown>
  );
}

export function releaseTagUrl(version: string): string {
  return `https://github.com/nima-karami/conduit/releases/tag/v${version}`;
}
