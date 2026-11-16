import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HostToWebview, RemoteAttachResult } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { requestHost } from '../host-request';
import { MACHINES_STR } from '../machines-strings';
import { type RemoteKey, remoteKeyId } from '../remote-sessions';
import { useSettings } from '../settings';
import { matchConhostCellWidths, windowsPtyOptions } from '../terminal-conpty';
import { terminalFontFamily } from '../terminal-fonts';
import { terminalGpu } from '../terminal-gpu';
import { registerTerminalQuerySwallowHandlers } from '../terminal-query-replies';
import { buildXtermTheme, monoStack } from '../xterm-theme';
import { disposeTerminal } from './safe-dispose';

// Attach can wait on the server's view.open round trip to the peer.
const ATTACH_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 15_000;

export interface RemotePaneProps {
  remote: RemoteKey;
  machineName: string;
  label: string;
  visible: boolean;
  onClosed(): void;
}

/**
 * A terminal attached to a session on another machine. Input is the remote's, so the pane has no
 * local PTY lifecycle: it attaches, paints, follows remote:data and remote:state, and detaches.
 * The attachment lives in RemoteAttachment; a resync remounts it, so each attach starts clean.
 */
export function RemotePane(props: RemotePaneProps) {
  // A resync is a fresh attachment: keyed, so the old one detaches and disposes before the new one.
  const [epoch, setEpoch] = useState(0);
  const onResync = useCallback(() => setEpoch((e) => e + 1), []);
  return <RemoteAttachment key={epoch} {...props} onResync={onResync} />;
}

function RemoteAttachment({
  remote,
  machineName,
  label,
  visible,
  onClosed,
  onResync,
}: RemotePaneProps & { onResync(): void }) {
  const { settings } = useSettings();
  const hostRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  const termRef = useRef<Terminal | null>(null);
  const [attaching, setAttaching] = useState(true);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [exited, setExited] = useState(false);
  const [drive, setDrive] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const { machineId, sessionId } = remote;

  // A hidden pane must keep its WebGL slot accounting in step with the stack, as TerminalPane does.
  useLayoutEffect(() => {
    visibleRef.current = visible;
    const term = termRef.current;
    if (term) terminalGpu.setVisible(term, visible);
  }, [visible]);

  // Theme and font follow the app; applied after the frame so the CSS variables already switched.
  // settings.theme is the trigger only: the palette is read off the document's CSS variables.
  // biome-ignore lint/correctness/useExhaustiveDependencies: same re-theme trigger as TerminalPane.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const id = requestAnimationFrame(() => {
      term.options.fontSize = settings.terminalFontSize;
      term.options.theme = buildXtermTheme(settings.surfaceColor);
    });
    return () => cancelAnimationFrame(id);
  }, [settings.terminalFontSize, settings.theme, settings.surfaceColor]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let viewId: string | null = null;
    let term: Terminal | null = null;
    let unregisterGpu: (() => void) | null = null;
    let driveOn = false;
    let ended = false;
    // The remote size is what the terminal opens at; the pane fits only when the owner types.
    let needFit = true;
    let ready = false;
    // Output can outrun the attach reply; it waits here until the terminal exists.
    const early: Extract<HostToWebview, { type: 'remote:data' | 'remote:state' }>[] = [];

    setAttaching(true);
    setAttachError(null);
    setFrozen(false);
    setExited(false);
    setDrive(false);

    const fitIfVisible = (fit: FitAddon): boolean => {
      if (!visibleRef.current || host.offsetWidth === 0 || host.offsetHeight === 0) return false;
      fit.fit();
      return true;
    };

    const handle = (m: Extract<HostToWebview, { type: 'remote:data' | 'remote:state' }>) => {
      if (!term) return;
      if (m.type === 'remote:data') {
        term.write(m.data);
        return;
      }
      if (m.size && (m.size.cols !== term.cols || m.size.rows !== term.rows)) {
        term.resize(m.size.cols, m.size.rows);
        needFit = true;
      }
      switch (m.state) {
        case 'live':
          setFrozen(false);
          return;
        case 'frozen':
          setFrozen(true);
          return;
        case 'exited':
          ended = true;
          setExited(true);
          term.write(`\r\n\x1b[2m${MACHINES_STR.processExited}\x1b[0m\r\n`);
          return;
        case 'resyncing':
          onResync();
          return;
      }
    };

    const onHost = (m: HostToWebview) => {
      if (m.type !== 'remote:data' && m.type !== 'remote:state') return;
      if (!ready) {
        early.push(m);
        return;
      }
      if (m.viewId === viewId) handle(m);
    };
    const unsubscribe = subscribe(onHost);

    const fail = (code: string) => {
      unsubscribe();
      setAttachError(MACHINES_STR.paneError(code));
      setAttaching(false);
    };

    requestHost(
      (requestId) => ({ type: 'remote:attach', requestId, machineId, sessionId }),
      ['remote:attached'],
      ATTACH_TIMEOUT_MS,
    ).then((reply) => {
      if (cancelled) {
        if (reply?.result.ok) post({ type: 'remote:detach', viewId: reply.result.viewId });
        return;
      }
      if (!reply) return fail('failed');
      const result: RemoteAttachResult = reply.result;
      if (!result.ok) return fail(result.error);

      viewId = result.viewId;
      const s = settingsRef.current;
      const t = new Terminal({
        cols: result.size.cols,
        rows: result.size.rows,
        fontFamily: terminalFontFamily() ?? monoStack(s.fontMono),
        fontSize: s.terminalFontSize,
        // Must be 1.0 so box-drawing characters connect vertically (see TerminalPane).
        lineHeight: 1.0,
        rescaleOverlappingGlyphs: true,
        cursorBlink: true,
        scrollback: 10000,
        theme: buildXtermTheme(),
        allowProposedApi: true,
        allowTransparency: true,
        ...windowsPtyOptions(result.windowsPty ?? undefined),
      });
      term = t;
      termRef.current = t;
      // Answers to the remote's own queries must not be typed back into it as input.
      registerTerminalQuerySwallowHandlers(t);
      const fit = new FitAddon();
      t.loadAddon(fit);
      matchConhostCellWidths(t);
      t.open(host);
      const reportGpuLoss = () => terminalGpu.reportLoss(t);
      t.element?.addEventListener('webglcontextlost', reportGpuLoss, true);
      unregisterGpu = terminalGpu.register(t, undefined, { visible: visibleRef.current });
      t.write(result.firstPaint);
      t.onData((data) => {
        if (!driveOn || ended) return;
        if (needFit && fitIfVisible(fit)) {
          needFit = false;
          post({ type: 'remote:resize', machineId, sessionId, cols: t.cols, rows: t.rows });
        }
        post({ type: 'remote:input', machineId, sessionId, data });
      });

      driveOn = result.drive;
      setDrive(result.drive);
      setAttaching(false);
      ready = true;
      for (const m of early.splice(0)) if (m.viewId === viewId) handle(m);
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unregisterGpu?.();
      if (term) disposeTerminal(term, []);
      termRef.current = null;
      host.replaceChildren();
      if (viewId !== null) post({ type: 'remote:detach', viewId });
    };
  }, [machineId, sessionId, onResync]);

  const close = () => {
    setClosing(true);
    setCloseError(null);
    requestHost(
      (requestId) => ({ type: 'remote:close', requestId, machineId, sessionId }),
      ['remote:closed'],
      CLOSE_TIMEOUT_MS,
    ).then((reply) => {
      setClosing(false);
      if (!reply) return setCloseError(MACHINES_STR.paneError('failed'));
      if (reply.error) return setCloseError(MACHINES_STR.paneError(reply.error));
      onClosed();
    });
  };

  const note =
    closeError ??
    attachError ??
    (attaching
      ? MACHINES_STR.attaching(machineName)
      : exited
        ? MACHINES_STR.exited
        : frozen
          ? MACHINES_STR.reconnecting(machineName)
          : drive
            ? ''
            : MACHINES_STR.readOnly(machineName));

  return (
    <section
      className={frozen ? 'remote-pane remote-pane--frozen' : 'remote-pane'}
      aria-label={label}
      style={visible ? undefined : { display: 'none' }}
      data-remote-key={remoteKeyId(remote)}
    >
      <header className="remote-pane-head">
        <span>{label}</span>
        <span className="machine-badge">{MACHINES_STR.badge(machineName)}</span>
        <button type="button" disabled={closing} onClick={close}>
          {MACHINES_STR.closeSession}
        </button>
      </header>
      <div className="remote-pane-body" ref={hostRef} />
      <p className="remote-pane-note" role="status" aria-live="polite">
        {note}
      </p>
    </section>
  );
}
