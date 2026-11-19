import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { useToastFloor } from '../toast-floor';

export interface PermissionsDrawerProps {
  title: string;
  badge?: string;
  subtitle?: ReactNode;
  closeLabel: string;
  closeGlyph: string;
  onClose(): void;
  opener?: HTMLElement;
  scrollKey?: string;
  /** Pinned under the scrolling body (canvas D3–D5); omitted when there is nothing to act on. */
  footer?: ReactNode;
  children: ReactNode;
}

/** The side panel of MCP › Roles and Agents: header and footer stay put, only the body scrolls. */
export function PermissionsDrawer({
  title,
  badge,
  subtitle,
  closeLabel,
  closeGlyph,
  onClose,
  opener,
  scrollKey,
  footer,
  children,
}: PermissionsDrawerProps) {
  const titleId = useId();
  const aside = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const foot = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useToastFloor(foot, footer !== undefined);
  useEffect(() => heading.current?.focus(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different view starts at its heading.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [scrollKey]);
  // Spec 2026-11-18-mcp-full-screen §10: closing returns focus to the row that opened it. A layout
  // cleanup still sees the drawer in the DOM, so it can tell whether focus was inside it.
  useLayoutEffect(() => {
    const returnFocus = opener ?? document.activeElement;
    const node = aside.current;
    return () => {
      const active = document.activeElement;
      const focusInside =
        node !== null &&
        (active === null || node.contains(active) || (opener && active === document.body));
      if (
        focusInside &&
        returnFocus instanceof HTMLElement &&
        returnFocus !== document.body &&
        returnFocus.isConnected &&
        !node.contains(returnFocus)
      )
        queueMicrotask(() => {
          // The panel switched content (drawer → editor) rather than closing: the new one has
          // already taken focus.
          if (document.activeElement?.closest('.permissions-drawer, .settings-page')) return;
          if (returnFocus.isConnected) returnFocus.focus();
        });
    };
  }, [opener]);
  return (
    <aside ref={aside} className="permissions-drawer" aria-labelledby={titleId}>
      <header className="permissions-drawer__head">
        <div className="permissions-drawer__titles">
          <div className="permissions-drawer__titleline">
            <h3 id={titleId} ref={heading} tabIndex={-1} className="permissions-drawer__title">
              {title}
            </h3>
            {badge && <span className="permissions-drawer__badge">{badge}</span>}
          </div>
          {subtitle && <p className="permissions-drawer__subtitle">{subtitle}</p>}
        </div>
        <button type="button" className="iconbtn" aria-label={closeLabel} onClick={onClose}>
          {closeGlyph}
        </button>
      </header>
      <div ref={body} className="permissions-drawer__body">
        {children}
      </div>
      {footer !== undefined && (
        <footer ref={foot} className="permissions-drawer__foot">
          {footer}
        </footer>
      )}
    </aside>
  );
}
