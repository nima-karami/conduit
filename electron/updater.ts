import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { HostToWebview } from '../src/protocol';
import { debInstallFailure } from './deb-install-failure';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const UPDATES_UNAVAILABLE_MSG = "Updates aren't available in this build.";

let intervalId: ReturnType<typeof setInterval> | null = null;
// The version offered by the most recent `update-available`. electron-updater's
// `download-progress` event carries only byte/percent info — no version — so we stash
// it here and echo it on every `downloading` message; otherwise the renderer card would
// read an undefined version mid-download and render "Updating to v?…".
let pendingVersion: string | undefined;
// The downloaded update file of the most recent `update-downloaded`. An install failure
// arrives as a bare `error` with no file, so the .deb path has to be remembered here.
let pendingDownloadedFile: string | null = null;

// An unpacked build (electron-builder --dir) is isPackaged but ships no
// resources/app-update.yml; electron-updater then ENOENTs on every check.
export function updatesSupported(resourcesPath: string, exists: (p: string) => boolean): boolean {
  return exists(path.join(resourcesPath, 'app-update.yml'));
}

function isSupported(): boolean {
  return updatesSupported(process.resourcesPath, fs.existsSync);
}

let lastSend: ((msg: HostToWebview) => void) | null = null;

export function initUpdater(
  send: (msg: HostToWebview) => void,
  onEvent: (event: string, data?: Record<string, unknown>) => void = () => {},
): () => void {
  if (!app.isPackaged) return () => {};

  lastSend = send;

  if (!isSupported()) {
    onEvent('unsupported');
    send({ type: 'updateStatus', status: 'error', message: UPDATES_UNAVAILABLE_MSG });
    return () => {
      lastSend = null;
    };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    onEvent('checking');
    send({ type: 'updateStatus', status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    onEvent('available', { version: info.version });
    send({
      type: 'updateStatus',
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    send({
      type: 'updateStatus',
      status: 'downloading',
      version: pendingVersion,
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    pendingDownloadedFile = info.downloadedFile;
    onEvent('downloaded', { version: info.version });
    send({
      type: 'updateStatus',
      status: 'ready',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    onEvent('up-to-date');
    send({ type: 'updateStatus', status: 'up-to-date' });
  });

  autoUpdater.on('error', (err) => {
    handleUpdaterError(err, {
      platform: process.platform,
      downloadedFile: pendingDownloadedFile,
      send,
      onEvent,
    });
  });

  void autoUpdater.checkForUpdates().catch(() => {});

  intervalId = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS);

  return () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    lastSend = null;
  };
}

interface UpdaterErrorContext {
  platform: string;
  downloadedFile: string | null;
  send: (msg: HostToWebview) => void;
  onEvent: (event: string, data?: Record<string, unknown>) => void;
}

// electron-updater emits `error` for install failures too (DebUpdater catches them and
// dispatches), so an unrecognised failure must keep its plain message.
export function handleUpdaterError(err: unknown, ctx: UpdaterErrorContext): void {
  const failure = debInstallFailure({
    platform: ctx.platform,
    downloadedFile: ctx.downloadedFile,
    error: err,
  });
  if (failure) {
    ctx.onEvent('deb-install-failed', { command: failure.command });
    ctx.send({
      type: 'updateStatus',
      status: 'error',
      message: failure.message,
      command: failure.command,
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  ctx.onEvent('error', { message });
  ctx.send({ type: 'updateStatus', status: 'error', message });
}

export function checkForUpdate(): void {
  if (!app.isPackaged) return;
  if (!isSupported()) {
    lastSend?.({ type: 'updateStatus', status: 'error', message: UPDATES_UNAVAILABLE_MSG });
    return;
  }
  void autoUpdater.checkForUpdates().catch(() => {});
}

export function quitAndInstall(): void {
  // isSilent=true, isForceRunAfter=true: with the one-click installer the update applies
  // with no installer UI and the app relaunches. (The old `false` showed the full wizard.)
  autoUpdater.quitAndInstall(true, true);
}
