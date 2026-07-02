import { IconChevronDown } from '../icons';
import { type TocEntry, tocIdsWithChildren, visibleTocEntries } from '../md-toc';

/**
 * Presentational document outline. All DOM scraping / scroll-spy lives in the parent
 * (MarkdownViewer); this renders entries, collapses nested sections, and reports jumps.
 */
export function MarkdownToc({
  entries,
  activeId,
  onJump,
  open,
  collapsed,
  onToggleCollapse,
}: {
  entries: TocEntry[];
  activeId: string | null;
  onJump: (id: string) => void;
  open: boolean;
  /** Ids of parent headings whose subtree is hidden. */
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
}) {
  if (!open || entries.length === 0) return null;

  const withChildren = tocIdsWithChildren(entries);
  const visible = visibleTocEntries(entries, collapsed);

  return (
    <nav className="markdown-toc" aria-label="Document outline">
      <ul className="markdown-toc__list">
        {visible.map((e) => {
          const active = e.id === activeId;
          const parent = withChildren.has(e.id);
          const isCollapsed = collapsed.has(e.id);
          return (
            <li key={e.id}>
              <div className="markdown-toc__row" style={{ paddingLeft: `${e.depth * 14}px` }}>
                {parent ? (
                  <button
                    type="button"
                    className="markdown-toc__toggle"
                    aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                    aria-expanded={!isCollapsed}
                    onClick={() => onToggleCollapse(e.id)}
                  >
                    <IconChevronDown
                      size={12}
                      className={`markdown-toc__chev${isCollapsed ? ' markdown-toc__chev--collapsed' : ''}`}
                    />
                  </button>
                ) : (
                  <span className="markdown-toc__toggle" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={`markdown-toc__item${active ? ' markdown-toc__item--active' : ''}`}
                  aria-current={active ? 'location' : undefined}
                  title={e.text}
                  onClick={() => onJump(e.id)}
                >
                  {e.text}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
