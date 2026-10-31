/**
 * The session layer of the MCP tool policy (spec 2026-10-30-conduit-mcp-tool-policy §8–§10):
 * the shared editor over session > CLI > global, each change saved through the host as a
 * one-field patch.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { cliKindOfHandle } from '../../src/conduit-mcp/handles';
import {
  type CliPolicyLayers,
  coercePolicyPatch,
  type GlobalPolicy,
  type PolicyLayer,
  type PolicyLayers,
  type PolicySource,
  type ToolName,
  type ToolPolicy,
  type ToolPolicyPatch,
  withPolicyPatch,
} from '../../src/conduit-mcp/tool-policy';
import type { Session } from '../../src/types';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconClose } from '../icons';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';
import { policyChoiceLabel, ToolPolicyEditor } from './tool-policy-editor';

export interface McpToolsDialogProps {
  session: Session;
  global: GlobalPolicy;
  byCli: CliPolicyLayers;
  masterOn: boolean;
  connected: boolean;
  /** Resolves false when the host didn't persist it; the row then reverts. */
  onChange(tool: ToolName, patch: ToolPolicyPatch): Promise<boolean>;
  onRelaunch(): void;
  announce(text: string): void;
  onClose(): void;
}

/** Puts one tool's whole entry back: every field it lacks becomes 'inherit'. */
const restorePatch = (entry: Partial<ToolPolicy> | undefined): ToolPolicyPatch => ({
  access: entry?.access ?? 'inherit',
  when: entry?.when ?? 'inherit',
  reach: entry?.reach ?? 'inherit',
  move: entry?.move ?? 'inherit',
});

export function McpToolsDialog({
  session,
  global,
  byCli,
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

  // What the controls show: the persisted session layer plus picks not yet confirmed.
  const [shown, setShown] = useState<PolicyLayer | undefined>(session.mcpToolPolicy);
  const [failed, setFailed] = useState<ReadonlySet<ToolName>>(new Set());
  const [changed, setChanged] = useState(false);
  // A revert goes to the tool's entry as the host last confirmed it in this dialog, else the
  // persisted props: the broadcast carrying a confirmed pick can arrive after a later pick has
  // already failed. Only the newest pick per tool may revert, so an older pick resolving late
  // can't undo it.
  const persistedRef = useRef(session.mcpToolPolicy);
  persistedRef.current = session.mcpToolPolicy;
  const confirmedRef = useRef(new Map<ToolName, Partial<ToolPolicy> | undefined>());
  const seqRef = useRef(new Map<ToolName, number>());
  // Picks not yet answered, per tool and field: a session-layer change from elsewhere (Always,
  // another window) re-seeds every other field, but must not flip a control mid-save.
  const pendingRef = useRef(new Map<ToolName, ToolPolicyPatch>());

  useEffect(() => {
    let next = session.mcpToolPolicy;
    for (const [tool, patch] of pendingRef.current) next = withPolicyPatch(next, tool, patch);
    setShown(next);
  }, [session.mcpToolPolicy]);

  // The CLI layer follows the handle (spec §2.1); a session that never connected has none.
  const kind = session.mcpHandle ? cliKindOfHandle(session.mcpHandle) : undefined;
  const layers: PolicyLayers = { session: shown, cli: kind ? byCli[kind] : undefined, global };
  const sourceName = (s: PolicySource): string => {
    if (s !== 'cli') return MCP_STR.tools.layerName[s];
    // Without a kind there is no CLI layer, so resolution never names it.
    return kind ? MCP_STR.tools.cliName[kind] : MCP_STR.tools.layerName.global;
  };

  useEffect(() => {
    const root = rootRef.current;
    const first =
      root?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]:not(:disabled)') ??
      root?.querySelector<HTMLElement>('button:not(:disabled)');
    first?.focus();
  }, []);

  const confirmedEntry = (tool: ToolName) =>
    confirmedRef.current.has(tool) ? confirmedRef.current.get(tool) : persistedRef.current?.[tool];

  const pick = async (tool: ToolName, patch: ToolPolicyPatch, what: string, value: string) => {
    const seq = (seqRef.current.get(tool) ?? 0) + 1;
    seqRef.current.set(tool, seq);
    pendingRef.current.set(tool, { ...pendingRef.current.get(tool), ...patch });
    setShown((o) => withPolicyPatch(o, tool, patch));
    setFailed((f) => withoutTool(f, tool));
    const ok = await onChange(tool, patch);
    if (ok) {
      const base: PolicyLayer = { [tool]: confirmedEntry(tool) };
      confirmedRef.current.set(tool, withPolicyPatch(base, tool, patch)?.[tool]);
    }
    if (seqRef.current.get(tool) !== seq) return;
    pendingRef.current.delete(tool);
    if (!ok) {
      const revertTo = restorePatch(confirmedEntry(tool));
      setShown((o) => withPolicyPatch(o, tool, revertTo));
      setFailed((f) => new Set(f).add(tool));
      return;
    }
    setChanged(true);
    announce(MCP_STR.tools.announce(what, value, session.name));
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
        <ToolPolicyEditor
          layer="session"
          layers={layers}
          sourceName={sourceName}
          disabled={!masterOn}
          failed={failed}
          onChange={(tool, field, value) => {
            const patch = coercePolicyPatch(tool, { [field]: value });
            const label = policyChoiceLabel(tool, field, value, {
              layer: 'session',
              layers,
              sourceName,
            });
            if (!patch || label === null) return;
            const what =
              field === 'access'
                ? MCP_STR.tools.accessLabel(tool)
                : MCP_STR.tools.fieldAria(tool, field);
            void pick(tool, patch, what, label);
          }}
        />
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

function withoutTool(set: ReadonlySet<ToolName>, tool: ToolName): ReadonlySet<ToolName> {
  if (!set.has(tool)) return set;
  const next = new Set(set);
  next.delete(tool);
  return next;
}
