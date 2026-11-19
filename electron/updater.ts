import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, autoUpdater as electronAutoUpdater, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { HostToWebview } from '../src/protocol';
import { debInstallFailure } from './deb-install-failure';
import { relaunchApp } from './relaunch';

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
let explicitInstallInProgress = false;
let downloadedAt: number | null = null;
let downloadedVersion: string | undefined;

// An unpacked build (electron-builder --dir) is isPackaged but ships no
// resources/app-update.yml; electron-updater then ENOENTs on every check.
export function updatesSupported(resourcesPath: string, exists: (p: string) => boolean): boolean {
  return exists(path.join(resourcesPath, 'app-update.yml'));
}

function isSupported(): boolean {
  return updatesSupported(process.resourcesPath, fs.existsSync);
}

let lastSend: ((msg: HostToWebview) => void) | null = null;

export function cgroupScopeKind(cgroup: string): string {
  const lines = cgroup.trim().split('\n');
  const line =
    lines.find((entry) => entry.startsWith('0::')) ??
    lines.find((entry) => /^\d+:name=systemd:/.test(entry)) ??
    lines[0];
  const leaf =
    line
      ?.replace(/^\d+:[^:]*:/, '')
      .split('/')
      .at(-1) ?? '';
  if (/^session-[^/]+\.scope$/.test(leaf)) return 'session.scope';
  if (/^app-[^/]+\.scope$/.test(leaf)) return 'app.scope';
  if (leaf.endsWith('.scope')) return 'terminal-or-other.scope';
  if (leaf.endsWith('.service')) return 'service';
  return 'other';
}

function linuxSessionState() {
  let scopeKind = 'unavailable';
  try {
    scopeKind = cgroupScopeKind(fs.readFileSync('/proc/self/cgroup', 'utf8'));
  } catch {
    // /proc can be unavailable in a sandbox.
  }
  const result = spawnSync(
    '/usr/bin/loginctl',
    ['show-session', 'self', '--property=Id', '--value'],
    {
      encoding: 'utf8',
      timeout: 1000,
      env: { ...process.env, LC_ALL: 'C' },
    },
  );
  const id = result.stdout?.trim();
  const sessionId = result.status === 0 && id && /^[a-z0-9]+$/i.test(id) ? id : null;
  const sessionLookup = sessionId
    ? 'found'
    : !result.error && result.stderr?.includes('Caller does not belong to any known session')
      ? 'none'
      : 'unavailable';
  return { scopeKind, sessionId, sessionLookup };
}

/** The `NoNewPrivs` field of /proc/<pid>/status: when set, setuid pkexec can't work. */
export function noNewPrivsFromStatus(status: string): boolean | null {
  const match = /^NoNewPrivs:\s*(\d)/m.exec(status);
  return match ? match[1] === '1' : null;
}

function readNoNewPrivs(): boolean | null {
  try {
    return noNewPrivsFromStatus(fs.readFileSync('/proc/self/status', 'utf8'));
  } catch {
    // /proc can be unavailable in a sandbox.
    return null;
  }
}

const debInstallers = new Map([
  ['snap-store_snap-store.desktop', 'App Center'],
  ['org.gnome.Software.desktop', 'GNOME Software'],
  ['org.kde.discover.desktop', 'Discover'],
  ['gdebi.desktop', 'GDebi'],
]);

function redactDiagnostic(message: unknown): string {
  return String(message).split(os.homedir()).join('~').slice(0, 4000);
}

async function openSystemInstaller(
  file: string,
  onEvent: UpdaterErrorContext['onEvent'],
): Promise<string | null> {
  const handler = spawnSync(
    '/usr/bin/xdg-mime',
    ['query', 'default', 'application/vnd.debian.binary-package'],
    { encoding: 'utf8', timeout: 1000 },
  );
  if (handler.error) throw handler.error;
  if (handler.status !== 0) {
    onEvent('deb-installer-open-failed', {
      reason: 'handler-query-failed',
      error: redactDiagnostic(handler.stderr),
    });
    return null;
  }
  const desktopId = handler.stdout.trim();
  const name = debInstallers.get(desktopId);
  if (!name) {
    onEvent('deb-installer-open-failed', {
      reason: 'unrecognized-handler',
      desktopId: redactDiagnostic(desktopId),
    });
    return null;
  }
  const error = await shell.openPath(file);
  if (error) {
    onEvent('deb-installer-open-failed', { reason: 'open-failed', error: redactDiagnostic(error) });
    return null;
  }
  return name;
}

export function initUpdater(
  send: (msg: HostToWebview) => void,
  onEvent: (event: string, data?: Record<string, unknown>) => void = () => {},
  windowState: () => { focused: boolean; visible: boolean } = () => ({
    focused: false,
    visible: false,
  }),
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

  const originalLogger = autoUpdater.logger;
  let pkexecCommand: string | undefined;
  const pkexecAttempts: { command: string; stderr: string }[] = [];
  autoUpdater.logger = {
    debug(message) {
      originalLogger?.debug?.(message);
    },
    info(message) {
      const line = typeof message === 'string' ? message : '';
      if (line.startsWith('Install: isSilent:')) pkexecAttempts.length = 0;
      const args = /^Executing: pkexec with args:(.*)$/.exec(line)?.[1];
      pkexecCommand =
        args === undefined ? undefined : (/,-c,'([a-z-]+)/.exec(args)?.[1] ?? 'unknown');
      originalLogger?.info(message);
    },
    warn(message) {
      originalLogger?.warn(message);
    },
    error(message) {
      if (pkexecCommand !== undefined) {
        pkexecAttempts.push({
          command: pkexecCommand,
          stderr: redactDiagnostic(message),
        });
        pkexecCommand = undefined;
      }
      originalLogger?.error(message);
    },
  };

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
    if (info.downloadedFile !== pendingDownloadedFile) autoUpdater.autoInstallOnAppQuit = true;
    pendingDownloadedFile = info.downloadedFile;
    downloadedAt = Date.now();
    downloadedVersion = info.version;
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
    const match =
      err instanceof Error ? /^Command pkexec exited with code (\d+)$/.exec(err.message) : null;
    if (
      process.platform === 'linux' &&
      pendingDownloadedFile?.toLowerCase().endsWith('.deb') &&
      match
    ) {
      const environment = Object.fromEntries(
        [
          'DISPLAY',
          'WAYLAND_DISPLAY',
          'XDG_SESSION_ID',
          'XDG_SESSION_TYPE',
          'DBUS_SESSION_BUS_ADDRESS',
        ].map((key) => [key, Boolean(process.env[key])]),
      );
      onEvent('deb-install-diagnostic', {
        exitCode: Number(match[1]),
        pkexecAttempts: [...pkexecAttempts],
        ...linuxSessionState(),
        environment,
        ...windowState(),
        version: downloadedVersion,
        noNewPrivs: readNoNewPrivs(),
        fileExists: fs.existsSync(pendingDownloadedFile),
        ageSeconds: downloadedAt === null ? null : Math.floor((Date.now() - downloadedAt) / 1000),
      });
    }
    if (
      explicitInstallInProgress &&
      process.platform === 'linux' &&
      pendingDownloadedFile?.toLowerCase().endsWith('.deb')
    ) {
      autoUpdater.autoInstallOnAppQuit = false;
    }
    void handleUpdaterError(err, {
      platform: process.platform,
      downloadedFile: pendingDownloadedFile,
      openInstaller: explicitInstallInProgress
        ? (file) => openSystemInstaller(file, onEvent)
        : undefined,
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
    autoUpdater.logger = originalLogger;
  };
}

interface UpdaterErrorContext {
  platform: string;
  downloadedFile: string | null;
  openInstaller?: (file: string) => Promise<string | null>;
  send: (msg: HostToWebview) => void;
  onEvent: (event: string, data?: Record<string, unknown>) => void;
}

// electron-updater emits `error` for install failures too (DebUpdater catches them and
// dispatches), so an unrecognised failure must keep its plain message.
export async function handleUpdaterError(err: unknown, ctx: UpdaterErrorContext): Promise<void> {
  const failure = debInstallFailure({
    platform: ctx.platform,
    downloadedFile: ctx.downloadedFile,
    error: err,
  });
  if (failure) {
    ctx.onEvent('deb-install-failed', { command: failure.command });
    let message = failure.message;
    if (ctx.openInstaller && ctx.downloadedFile) {
      try {
        const installer = await ctx.openInstaller(ctx.downloadedFile);
        if (installer) {
          message = `The update opened in ${installer}. Click Install there, then restart Conduit. You can also install it from a terminal:`;
          ctx.onEvent('deb-installer-opened');
        }
      } catch (error) {
        ctx.onEvent('deb-installer-open-failed', {
          reason: 'exception',
          error: redactDiagnostic(error),
        });
      }
    }
    ctx.send({
      type: 'updateStatus',
      status: 'error',
      message,
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

/**
 * How to call `quitAndInstall`: a .deb install must not let electron-updater relaunch, since its
 * `app.relaunch()` child can never use pkexec (CON-74). AppImageUpdater already relaunches with
 * a Node spawn, and needs isForceRunAfter, or it runs the new AppImage to exit after install.
 */
export function installPlan(
  platform: string,
  env: NodeJS.ProcessEnv,
): { forceRunAfter: boolean; relaunchOurselves: boolean } {
  const ownRelaunch = platform === 'linux' && !env.APPIMAGE;
  return { forceRunAfter: !ownRelaunch, relaunchOurselves: ownRelaunch };
}

export function quitAndInstall(): void {
  // isSilent=true: with the one-click installer the update applies with no installer UI.
  // (The old `false` showed the full wizard.)
  const plan = installPlan(process.platform, process.env);
  // BaseUpdater emits this (in a setImmediate, before quitting) only when the install went
  // through; a failed or ignored install ("quitAndInstallCalled is set") emits nothing.
  const relaunchAfterInstall = () => relaunchApp();
  if (plan.relaunchOurselves) {
    electronAutoUpdater.once('before-quit-for-update', relaunchAfterInstall);
  }
  explicitInstallInProgress = true;
  try {
    autoUpdater.quitAndInstall(true, plan.forceRunAfter);
  } finally {
    explicitInstallInProgress = false;
    // Queued after BaseUpdater's setImmediate, so it runs once that emit had its chance.
    if (plan.relaunchOurselves) {
      setImmediate(() =>
        electronAutoUpdater.removeListener('before-quit-for-update', relaunchAfterInstall),
      );
    }
  }
}
