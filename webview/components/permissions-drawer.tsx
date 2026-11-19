import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { useToastFloor } from '../toast-floor';

export interface PermissionsDrawerProps {
  title: string;
  badge?: string;
  subtitle?: ReactNode;
  closeLabel: string;
  closeGlyph: string;
  onClose(): void;
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
  footer,
  children,
}: PermissionsDrawerProps) {
  const titleId = useId();
  const aside = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const foot = useRef<HTMLElement>(null);
  useToastFloor(foot, footer !== undefined);
  useEffect(() => heading.current?.focus(), []);
  // Spec 2026-11-18-mcp-full-screen §10: closing returns focus to the row that opened it. A layout
  // cleanup still sees the drawer in the DOM, so it can tell whether focus was inside it.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const node = aside.current;
    return () => {
      const active = document.activeElement;
      const focusInside = node !== null && (active === null || node.contains(active));
      if (
        focusInside &&
        opener instanceof HTMLElement &&
        opener.isConnected &&
        !node.contains(opener)
      )
        queueMicrotask(() => {
          if (opener.isConnected) opener.focus();
        });
    };
  }, []);
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
      <div className="permissions-drawer__body">{children}</div>
      {footer !== undefined && (
        <footer ref={foot} className="permissions-drawer__foot">
          {footer}
        </footer>
      )}
    </aside>
  );
}
