import type { HcClient, HcStream, HcStreamEnd } from '../src/contracts/hc';
import type {
  AttachTarget,
  FirstPaint,
  TerminalLink,
  TerminalLinkFactory,
} from '../src/contracts/terminal-link';
import { PaintCollector } from '../src/paint-collector';
import type { TermGeometry } from '../src/protocol';
import type { createHcEvents } from './hc-events';
import type { AppLog } from './server-client';

const exitCodeOf = (end: HcStreamEnd): number | null =>
  'exit_code' in end ? (end.exit_code ?? null) : null;

/**
 * C5: the app is an hc `observe` viewer. It never writes, resizes or sends facts on the stream:
 * those go to the server over C2, the only active viewer (D19).
 */
export function createTerminalLinkFactory(d: {
  hc: HcClient;
  hcSession: string;
  hcEvents: ReturnType<typeof createHcEvents>;
  log: AppLog;
}): TerminalLinkFactory {
  return {
    attach(sessionId, target: AttachTarget, size: TermGeometry, history, events) {
      if (target.hcSession !== d.hcSession)
        return Promise.reject(
          new Error(`attach target is in hc session ${target.hcSession}, not ${d.hcSession}`),
        );
      const wire = (stream: HcStream): Promise<TerminalLink> => {
        const offSize = d.hcEvents.on(target.terminal, (e) => {
          if (e.type !== 'size') return;
          if (e.data.cols !== size.cols || e.data.rows !== size.rows)
            d.log('info', 'terminal-link: size differs from the attach size', {
              sessionId,
              attached: size,
              reported: e.data,
            });
          events.size({ cols: e.data.cols, rows: e.data.rows });
        });
        let detached = false;
        let painted: (paint: FirstPaint) => void = () => {};
        const firstPaint = new Promise<FirstPaint>((resolve) => {
          painted = resolve;
        });
        const paint = new PaintCollector((data) =>
          painted({ data, replay: [{ length: data.length, geometry: size }] }),
        );
        const decoder = new TextDecoder();
        stream.onData((bytes) => {
          const text = decoder.decode(bytes, { stream: true });
          if (paint.done) events.data(text);
          else paint.push(text);
          stream.credit(bytes.byteLength);
        });
        stream.onClose((end) => {
          offSize();
          paint.end();
          if (detached) return;
          // Chained on the promise the caller awaits, so the caller holds the link first.
          void linked.then(() =>
            events.closed(end.reason, exitCodeOf(end), end.reason === 'disconnected'),
          );
        });
        return firstPaint.then((fp) => ({
          sessionId,
          firstPaint: fp,
          close() {
            if (detached) return;
            detached = true;
            offSize();
            stream.close();
          },
        }));
      };
      const linked: Promise<TerminalLink> = d.hc
        .attach({
          terminal: target.terminal,
          observe: true,
          history,
          cols: size.cols,
          rows: size.rows,
        })
        .then(({ stream }) => wire(stream));
      return linked;
    },
  };
}
