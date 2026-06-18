import type { TocEntry } from '../md-toc';

/**
 * Presentational document outline. All DOM scraping / scroll-spy lives in the parent
 * (MarkdownViewer); this just renders entries and reports jumps.
 */
export function MarkdownToc({
  entries,
  activeId,
  onJump,
  open,
}: {
  entries: TocEntry[];
  activeId: string | null;
  onJump: (id: string) => void;
  open: boolean;
}) {
  if (!open || entries.length === 0) return null;

  return (
    <nav className="markdown-toc" aria-label="Document outline">
      <ul className="markdown-toc__list">
        {entries.map((e) => {
          const active = e.id === activeId;
          return (
            <li key={e.id}>
              <button
                type="button"
                className={`markdown-toc__item${active ? ' markdown-toc__item--active' : ''}`}
                style={{ paddingLeft: `${10 + e.depth * 14}px` }}
                aria-current={active ? 'location' : undefined}
                title={e.text}
                onClick={() => onJump(e.id)}
              >
                {e.text}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
