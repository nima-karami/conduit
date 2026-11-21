import { createHash } from 'node:crypto';
import { globSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import type { FileManagerStatus } from './status';

interface LinuxIntegrationOptions {
  data: string;
  config: string;
  userData: string;
  executable: string;
  extension: string;
  systemExtension: string;
  hasNautilus: () => boolean;
}

const actionId = 'com.nimakarami.conduit.open';
const desktopString = (value: string) =>
  value.replace(
    /[\\\n\t\r]/g,
    (char) => ({ '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r' })[char] ?? char,
  );
const desktopExec = (value: string) =>
  desktopString(`"${value.replace(/["`$\\]/g, '\\$&').replaceAll('%', '%%')}"`);
const shellWord = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xmlText = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function read(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function write(file: string, content: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFileSync(file, content, undefined, { mode });
}

export function linuxRoots(home: string, env: NodeJS.ProcessEnv) {
  const root = env.CONDUIT_OS_INTEGRATION_ROOT;
  if (root) return { data: join(root, 'data'), config: join(root, 'config') };
  const xdg = (value: string | undefined, fallback: string) =>
    value && isAbsolute(value) ? value : join(home, fallback);
  return {
    data: xdg(env.XDG_DATA_HOME, '.local/share'),
    config: xdg(env.XDG_CONFIG_HOME, '.config'),
  };
}

export function hasNautilusPython(): boolean {
  return (
    globSync([
      '/usr/lib/nautilus/extensions-4/libnautilus-python.so',
      '/usr/lib/*/nautilus/extensions-4/libnautilus-python.so',
      '/usr/lib64/nautilus/extensions-4/libnautilus-python.so',
      '/usr/local/lib/nautilus/extensions-4/libnautilus-python.so',
    ]).length > 0
  );
}

export function linuxIntegration(opts: LinuxIntegrationOptions) {
  const marker = join(opts.config, 'Conduit', 'file-manager-off');
  const manifestFile = join(opts.userData, 'file-manager-integration.json');
  const thunar = join(opts.config, 'Thunar', 'uca.xml');
  const extension = join(opts.data, 'nautilus-python', 'extensions', 'conduit.py');
  const fallback = join(opts.data, 'nautilus', 'scripts', 'Open in Conduit');
  const dolphin = join(opts.data, 'kio', 'servicemenus', 'conduit.desktop');
  const nemo = join(opts.data, 'nemo', 'actions', 'conduit.nemo_action');
  const paths = [extension, fallback, dolphin, nemo];
  const emptyThunar = '<?xml version="1.0" encoding="UTF-8"?>\n<actions>\n</actions>\n';
  const action = `<action><icon>conduit</icon><name>Open in Conduit</name><unique-id>${actionId}</unique-id><command>${xmlText(shellWord(opts.executable.replaceAll('%', '%%')))} %F</command><patterns>*</patterns><directories/><audio-files/><image-files/><text-files/><video-files/><other-files/></action>\n`;
  let restartFiles = false;

  interface Manifest {
    files: Record<string, string[]>;
    thunar?: { created: boolean };
  }

  function load(): Manifest {
    const raw = read(manifestFile);
    return raw ? JSON.parse(raw) : { files: {} };
  }

  function save(manifest: Manifest): void {
    write(manifestFile, JSON.stringify(manifest));
  }

  function fileHash(file: string): string | undefined {
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (!entry) return undefined;
    if (!entry.isFile()) return '';
    const content = read(file);
    return content === undefined ? undefined : digest(content);
  }

  function install(manifest: Manifest, file: string, content: string, mode?: number): void {
    const current = fileHash(file);
    const previous = manifest.files[file] ?? [];
    if (current !== undefined && !previous.includes(current)) {
      throw new Error(`A file already exists at ${file}`);
    }
    const next = digest(content);
    manifest.files[file] = [...new Set([next, ...previous])];
    save(manifest);
    if (current !== next) write(file, content, mode);
    manifest.files[file] = [next];
    save(manifest);
  }

  function remove(manifest: Manifest, file: string): void {
    const owned = manifest.files[file];
    if (!owned) return;
    const current = fileHash(file);
    if (current !== undefined && owned.includes(current)) rmSync(file, { force: true });
  }

  function thunarAction(xml: string) {
    // Thunar writes flat action records. Skip XML comments and CDATA when finding our record.
    const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?action\s*>/g;
    let start = -1;
    for (const match of xml.matchAll(tokens)) {
      if (match[0].startsWith('<action')) start = match.index;
      if (!match[0].startsWith('</action') || start < 0) continue;
      const end = match.index + match[0].length;
      const record = xml.slice(start, end);
      const fields = record.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
      if (fields.includes(`<unique-id>${actionId}</unique-id>`)) return { start, end, record };
      start = -1;
    }
  }

  function updateThunar(manifest: Manifest, enabled: boolean): void {
    const existing = read(thunar);
    const xml = existing ?? emptyThunar;
    const own = thunarAction(xml);
    if (enabled) {
      if (own && !manifest.thunar) throw new Error(`A Conduit action already exists in ${thunar}`);
      if (own?.record === action.trimEnd()) return;
      const base = own ? xml.slice(0, own.start) + xml.slice(own.end).replace(/^\r?\n/, '') : xml;
      const tokens =
        /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<actions\s*\/>|<\/actions\s*>/g;
      const root = [...base.matchAll(tokens)].find(([token]) => /^<\/?actions/.test(token));
      if (!root) throw new Error(`Could not find the Thunar actions root in ${thunar}`);
      const [token] = root;
      const before = base.slice(0, root.index);
      const after = base.slice(root.index + token.length);
      const next = token.startsWith('</')
        ? before + action + token + after
        : `${before}<actions>\n${action}</actions>${after}`;
      manifest.thunar ??= { created: existing === undefined };
      save(manifest);
      write(thunar, next);
    } else if (manifest.thunar) {
      if (own) {
        const rest = xml.slice(0, own.start) + xml.slice(own.end).replace(/^\r?\n/, '');
        if (manifest.thunar.created && rest === emptyThunar) rmSync(thunar, { force: true });
        else write(thunar, rest);
      }
    }
  }

  const systemInstalled = () =>
    Boolean(statSync(opts.systemExtension, { throwIfNoEntry: false })?.isFile());

  function disable(manifest: Manifest): void {
    // Keep ownership fingerprints so startup can clean up files restored after an off request.
    if (!lstatSync(marker, { throwIfNoEntry: false })) write(marker, '');
    for (const file of paths) remove(manifest, file);
    updateThunar(manifest, false);
  }

  function status(): FileManagerStatus {
    const manifest = load();
    const enabled =
      !lstatSync(marker, { throwIfNoEntry: false }) &&
      (paths.some((file) => Boolean(manifest.files[file]?.includes(fileHash(file) ?? ''))) ||
        Boolean(manifest.thunar && thunarAction(read(thunar) ?? '')) ||
        systemInstalled());
    if (enabled && !opts.hasNautilus()) return { enabled, notice: 'missing-nautilus' };
    return restartFiles ? { enabled, notice: 'restart-files' } : { enabled };
  }

  function setEnabled(enabled: boolean): FileManagerStatus {
    const manifest = load();
    if (enabled) {
      const launcher = JSON.stringify(opts.executable);
      const system = systemInstalled();
      if (system) {
        remove(manifest, extension);
      } else {
        const template = read(opts.extension);
        if (!template) throw new Error('The Nautilus extension template is missing');
        install(
          manifest,
          extension,
          template.replace('"/usr/bin/conduit"', () => launcher),
        );
      }
      if (system || opts.hasNautilus()) {
        remove(manifest, fallback);
      } else {
        install(
          manifest,
          fallback,
          `#!/usr/bin/env python3
import os
import sys
from urllib.parse import unquote, urlsplit

# Nautilus' path list uses newlines as separators. Its URI list preserves encoded newlines.
uris = os.environ.get("NAUTILUS_SCRIPT_SELECTED_URIS", "").splitlines()
paths = [unquote(url.path, errors="surrogateescape") for uri in uris
         if (url := urlsplit(uri)).scheme == "file" and url.netloc in ("", "localhost")]
if not uris:
    paths = sys.argv[1:] or os.environ.get("NAUTILUS_SCRIPT_SELECTED_FILE_PATHS", "").splitlines()
if not paths and not uris:
    current = urlsplit(os.environ.get("NAUTILUS_SCRIPT_CURRENT_URI", ""))
    if current.scheme == "file" and current.netloc in ("", "localhost"):
        paths = [unquote(current.path, errors="surrogateescape")]
if paths:
    os.execv(${launcher}, [${launcher}, *paths])
`,
          0o755,
        );
      }
      install(
        manifest,
        dolphin,
        `[Desktop Entry]
Type=Service
MimeType=all/all;
Actions=openInConduit;

[Desktop Action openInConduit]
Name=Open in Conduit
Icon=conduit
Exec=${desktopExec(opts.executable)} %F
`,
        0o755,
      );
      install(
        manifest,
        nemo,
        `[Nemo Action]
Name=Open in Conduit
Exec=${desktopString(shellWord(opts.executable))} %F
Selection=any
Extensions=any;
Quote=double
`,
      );
      updateThunar(manifest, true);
      rmSync(marker, { force: true });
    } else {
      disable(manifest);
    }
    restartFiles = true;
    return status();
  }

  return { status, setEnabled, reconcileOff: () => disable(load()) };
}
