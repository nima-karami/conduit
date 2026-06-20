/**
 * Renderer-side leveled logger (Slice B). Gives renderer code the same
 * `log.<level>(scope, msg, data?)` shape as the host logger, routing each call through the
 * existing `{ type: 'log', level, scope, message, data? }` channel to the host's single disk
 * writer (which gates + redacts before writing). Level NAMES match the host `LogLevel`.
 *
 * When the bridge is absent (fake-shell preview), there is no disk sink — fall back to the
 * console so a renderer-side failure is still visible. Never throws (a logging failure must
 * never crash the renderer).
 */

import { isHosted, logToHost } from './bridge';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace';

function emit(level: Level, scope: string, message: string, data?: Record<string, unknown>): void {
  try {
    if (isHosted) {
      logToHost(message, { level, scope, data });
      return;
    }
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${scope}] ${message}`, data ?? '');
  } catch {
    /* logging must never throw into a caller */
  }
}

export const log = {
  error: (scope: string, message: string, data?: Record<string, unknown>) =>
    emit('error', scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) =>
    emit('warn', scope, message, data),
  info: (scope: string, message: string, data?: Record<string, unknown>) =>
    emit('info', scope, message, data),
  debug: (scope: string, message: string, data?: Record<string, unknown>) =>
    emit('debug', scope, message, data),
  trace: (scope: string, message: string, data?: Record<string, unknown>) =>
    emit('trace', scope, message, data),
};

// Test seam: the e2e suite drives the REAL renderer logger (not the raw `log` channel) to
// prove parity end-to-end. esbuild bundles this module, so it isn't importable from the page
// context — exposing it on a debug global is the one reliable way to invoke it under Playwright.
declare global {
  interface Window {
    __conduitLog?: typeof log;
  }
}
if (typeof window !== 'undefined') window.__conduitLog = log;
