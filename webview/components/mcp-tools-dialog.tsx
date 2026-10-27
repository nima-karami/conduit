/**
 * Per-session MCP tool overrides (spec 2026-10-27-conduit-mcp-control-tools §8–§10): one
 * Inherit / On / Off group per tool, saved through the host as each one changes.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  CONTROL_TOOL_NAMES,
  type McpToolSwitches,
  MESSAGING_TOOL_NAMES,
  type ToolName,
  type ToolOverrideValue,
  withOverride,
} from '../../src/conduit-mcp/tool-switches';
import type { Session } from '../../src/types';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconClose } from '../icons';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';
import { SegmentedRadios } from './segmented-radios';

export interface McpToolsDialogProps {
  session: Session;
  global: McpToolSwitches;
  masterOn: boolean;
  connected: boolean;
  /** Resolves false when the host didn't persist it; the control then reverts. */
  onChange(tool: ToolName, value: ToolOverrideValue): Promise<boolean>;
  onRelaunch(): void;
  announce(text: string): void;
  onClose(): void;
}

type Seg = 'inherit' | 'on' | 'off';

const toSeg = (v: boolean | undefined): Seg => (v === undefined ? 'inherit' : v ? 'on' : 'off');
const fromSeg = (s: Seg): ToolOverrideValue => (s === 'inherit' ? 'inherit' : s === 'on');

const GROUPS = [
  { title: MCP_STR.tools.groupMessaging, tools: MESSAGING_TOOL_NAMES },
  { title: MCP_STR.tools.groupControl, tools: CONTROL_TOOL_NAMES },
] as const;

export function McpToolsDialog({
  session,
  global,
  masterOn,
  connected,
  onChange,
  onRelaunch,
  announce,
  onClose,
}: McpToolsDialogProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);

  // What the controls show: the persisted overrides plus picks not yet confirmed.
  const [shown, setShown] = useState(session.mcpToolOverrides);
  const [failed, setFailed] = useState<ReadonlySet<ToolName>>(new Set());
  const [changed, setChanged] = useState(false);
  // A revert goes to the last value the host confirmed in this dialog, else the persisted props:
  // the broadcast carrying a confirmed pick can arrive after a later pick has already failed.
  // Only the newest pick per tool may revert, so an older pick resolving late can't undo it.
  const persistedRef = useRef(session.mcpToolOverrides);
  persistedRef.current = session.mcpToolOverrides;
  const confirmedRef = useRef(new Map<ToolName, ToolOverrideValue>());
  const seqRef = useRef(new Map<ToolName, number>());

  useEffect(() => {
    const root = rootRef.current;
    const first =
      root?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]:not(:disabled)') ??
      root?.querySelector<HTMLElement>('button:not(:disabled)');
    first?.focus();
  }, []);

  const pick = async (tool: ToolName, next: Seg) => {
    const seq = (seqRef.current.get(tool) ?? 0) + 1;
    seqRef.current.set(tool, seq);
    setShown((o) => withOverride(o, tool, fromSeg(next)));
    setFailed((f) => withoutTool(f, tool));
    const ok = await onChange(tool, fromSeg(next));
    if (ok) confirmedRef.current.set(tool, fromSeg(next));
    if (seqRef.current.get(tool) !== seq) return;
    if (!ok) {
      const revertTo = confirmedRef.current.get(tool) ?? persistedRef.current?.[tool] ?? 'inherit';
      setShown((o) => withOverride(o, tool, revertTo));
      setFailed((f) => new Set(f).add(tool));
      return;
    }
    setChanged(true);
    announce(MCP_STR.tools.announce(tool, segLabel(next, global[tool]), session.name));
  };

  return (
    <ModalLayer onDismiss={onClose}>
      <div
        ref={rootRef}
        className="mcptools chamfer"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcptools__head">
          <span className="mcptools__title" id={titleId} dir="auto">
            {MCP_STR.tools.dialogTitle(session.name)}
          </span>
          <button type="button" className="iconbtn" aria-label={MCP_STR.close} onClick={onClose}>
            <IconClose size={12} />
          </button>
        </div>
        {!masterOn && <p className="mcptools__hint">{MCP_STR.tools.masterOffHint}</p>}
        {GROUPS.map((g) => (
          <section key={g.title} className="mcptools__group">
            <h3 className="mcptools__grouptitle">{g.title}</h3>
            {g.tools.map((tool) => (
              <div key={tool} className="mcptools__row">
                <div className="mcptools__label">
                  <code className="mcptools__name">{tool}</code>
                  <span className="mcptools__desc">{MCP_STR.tools.description[tool]}</span>
                </div>
                <SegmentedRadios<Seg>
                  label={tool}
                  value={toSeg(shown?.[tool])}
                  disabled={!masterOn}
                  selectOnArrow={false}
                  options={[
                    { id: 'inherit', label: MCP_STR.tools.inherit(global[tool]) },
                    { id: 'on', label: MCP_STR.tools.on },
                    { id: 'off', label: MCP_STR.tools.off },
                  ]}
                  onChange={(next) => void pick(tool, next)}
                />
                {failed.has(tool) && (
                  <p className="mcptools__error" role="status">
                    {MCP_STR.tools.saveFailed}
                  </p>
                )}
              </div>
            ))}
          </section>
        ))}
        {connected && changed && (
          <div className="mcptools__relaunch">
            <span className="mcptools__hint">{MCP_STR.tools.relaunchHint}</span>
            <button type="button" className="btn btn--sm" onClick={onRelaunch}>
              {MCP_STR.tools.relaunch}
            </button>
          </div>
        )}
      </div>
    </ModalLayer>
  );
}

function segLabel(s: Seg, inherited: boolean): string {
  if (s === 'inherit') return MCP_STR.tools.inherit(inherited);
  return s === 'on' ? MCP_STR.tools.on : MCP_STR.tools.off;
}

function withoutTool(set: ReadonlySet<ToolName>, tool: ToolName): ReadonlySet<ToolName> {
  if (!set.has(tool)) return set;
  const next = new Set(set);
  next.delete(tool);
  return next;
}
