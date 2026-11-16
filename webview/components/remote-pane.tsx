import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HostToWebview, RemoteAttachResult } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { type FocusTarget, registerFocusTarget, terminalFocusKey } from '../focus-targets';
import { requestHost } from '../host-request';
import { MACHINES_STR } from '../machines-strings';
import { type RemoteKey, remoteKeyId } from '../remote-sessions';
import { useSettings } from '../settings';
import { matchConhostCellWidths } from '../terminal-conpty';
import { terminalGpu } from '../terminal-gpu';
import { attachTerminalGpu, baseTerminalOptions } from '../terminal-options';
import { registerTerminalQuerySwallowHandlers } from '../terminal-query-replies';
import { buildXtermTheme } from '../xterm-theme';
import { disposeTerminal } from './safe-dispose';

// Attach can wait on the server's view.open round trip to the peer.
const ATTACH_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 15_000;

type RemoteMessage = Extract<HostToWebview, { type: 'remote:data' | 'remote:state' }>;

export interface RemotePaneProps {
  remote: RemoteKey;
  machineName: string;
  label: string;
  visible: boolean;
  onClosed(remote: RemoteKey): void;
}

/**
 * A terminal attached to a session on another machine. Input is the remote's, so the pane has no
 * local PTY lifecycle: it attaches, paints, follows remote:data and remote:state, and detaches.
 */
export function RemotePane({ remote, machineName, label, visible, onClosed }: RemotePaneProps) {
  const { settings } = useSettings();
  // Read at attach time, so an attach never re-runs for a settings change.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const visibleRef = useRef(visible);
  // The next keystroke fits the pane and tells the remote, rather than fitting on every change.
  const staleRef = useRef(true);
  const mountedRef = useRef(true);
  const [attaching, setAttaching] = useState(true);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [exited, setExited] = useState(false);
  const [drive, setDrive] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const { machineId, sessionId } = remote;
  const remoteId = remoteKeyId(remote);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A hidden pane must keep its WebGL slot accounting in step with the stack, as TerminalPane does.
  useLayoutEffect(() => {
    visibleRef.current = visible;
    const term = termRef.current;
    if (term) terminalGpu.setVisible(term, visible);
  }, [visible]);

  // Focus Terminal (the center's forwarding target) lands here, on this pane's own xterm.
  useLayoutEffect(() => {
    const target: FocusTarget = { focus: () => termRef.current?.focus() };
    return registerFocusTarget(terminalFocusKey(remoteId), target);
  }, [remoteId]);

  // Theme and font follow the app. A font-size change moves the cell, so the next input refits.
  // The palette is read off the document's CSS variables, which the frame has not yet switched on
  // the commit that changed the setting, so the apply waits for the frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: settings.theme is the re-theme trigger — the palette is read off <html>'s CSS vars, not from the value.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const id = requestAnimationFrame(() => {
      if (term.options.fontSize !== settings.terminalFontSize) staleRef.current = true;
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
    let ready = false;
    // Output can outrun the attach reply; it waits here until the terminal exists.
    const early: RemoteMessage[] = [];

    setAttaching(true);
    setAttachError(null);
    setFrozen(false);
    setExited(false);
    setDrive(false);

    // The pane's own size changing (a split, a window) moves the cell count; the next input refits.
    const resizeObserver = new ResizeObserver(() => {
      if (driveOn) staleRef.current = true;
    });
    resizeObserver.observe(host);

    const fitIfVisible = (fit: FitAddon): boolean => {
      if (!visibleRef.current || host.offsetWidth === 0 || host.offsetHeight === 0) return false;
      fit.fit();
      return true;
    };

    const handle = (m: RemoteMessage) => {
      if (!term) return;
      if (m.type === 'remote:data') {
        term.write(m.data);
        return;
      }
      if (m.size && (m.size.cols !== term.cols || m.size.rows !== term.rows)) {
        term.resize(m.size.cols, m.size.rows);
        staleRef.current = true;
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
          // The relay re-opens this same view: its fresh first paint follows as remote:data.
          term.reset();
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
        ...baseTerminalOptions({
          fontMono: s.fontMono,
          fontSize: s.terminalFontSize,
          windowsPty: result.windowsPty ?? undefined,
        }),
        cols: result.size.cols,
        rows: result.size.rows,
      });
      term = t;
      termRef.current = t;
      // Answers to the remote's own queries must not be typed back into it as input.
      registerTerminalQuerySwallowHandlers(t);
      const fit = new FitAddon();
      t.loadAddon(fit);
      matchConhostCellWidths(t);
      t.open(host);
      unregisterGpu = attachTerminalGpu(t, { visible: visibleRef.current });
      t.write(result.firstPaint);
      t.onData((data) => {
        if (!driveOn || ended) return;
        if (staleRef.current && fitIfVisible(fit)) {
          staleRef.current = false;
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
      resizeObserver.disconnect();
      unregisterGpu?.();
      if (term) disposeTerminal(term, []);
      termRef.current = null;
      host.replaceChildren();
      if (viewId !== null) post({ type: 'remote:detach', viewId });
    };
  }, [machineId, sessionId]);

  const close = () => {
    setClosing(true);
    setCloseError(null);
    requestHost(
      (requestId) => ({ type: 'remote:close', requestId, machineId, sessionId }),
      ['remote:closed'],
      CLOSE_TIMEOUT_MS,
    ).then((reply) => {
      // A reply that lands after unmount belongs to a pane the owner has already left.
      if (!mountedRef.current) return;
      setClosing(false);
      if (!reply) return setCloseError(MACHINES_STR.paneError('failed'));
      if (reply.error) return setCloseError(MACHINES_STR.paneError(reply.error));
      onClosed(remote);
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
      data-remote-key={remoteId}
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
