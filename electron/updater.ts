import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { HostToWebview } from '../src/protocol';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let intervalId: ReturnType<typeof setInterval> | null = null;

export function initUpdater(send: (msg: HostToWebview) => void): () => void {
  if (!app.isPackaged) return () => {};

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    send({ type: 'updateStatus', status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
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
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    send({
      type: 'updateStatus',
      status: 'ready',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    send({ type: 'updateStatus', status: 'up-to-date' });
  });

  autoUpdater.on('error', (err) => {
    send({ type: 'updateStatus', status: 'error', message: err?.message ?? String(err) });
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
  };
}

export function checkForUpdate(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates().catch(() => {});
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true);
}
