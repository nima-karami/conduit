import type { GroupIndex } from '../doc-groups';
import { EditorGroupContext } from '../editor-group-context';
import { SPLIT_COPY } from '../split-editor-copy';

export function EditorGroupPane({
  group,
  active,
  tabs,
  top,
  children,
  onFocusGroup,
}: {
  group: GroupIndex;
  active: boolean;
  tabs: React.ReactNode;
  top?: React.ReactNode;
  children: React.ReactNode;
  onFocusGroup: (g: GroupIndex) => void;
}) {
  return (
    <section
      className="editor-group"
      role="group"
      aria-label={SPLIT_COPY.groupLabel(group, active)}
      data-group={group}
      data-active={active || undefined}
      onPointerDownCapture={() => onFocusGroup(group)}
      onFocusCapture={() => onFocusGroup(group)}
    >
      {tabs}
      <div className="editor-group__body" tabIndex={-1}>
        {top}
        <EditorGroupContext.Provider value={group}>{children}</EditorGroupContext.Provider>
      </div>
    </section>
  );
}
