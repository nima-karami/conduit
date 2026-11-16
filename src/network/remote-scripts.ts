// Fixed one-shot scripts for bootstrapping a remote Conduit over ssh (spec §8, plan decisions 1-6).
// The scripts are constants. Every value reaches them only as base64 argv, so no value is ever
// spliced into script text. Each script ends by printing one `CONDUIT_RESULT <json>` line.
import { AGENT_CLIS, CLI_BINARIES } from '../conduit-mcp/install-types';

export type ShellFamily = 'sh' | 'powershell' | 'cmd';

/** The one probe every shell runs; its output tells the families apart (decision 1). */
export const FAMILY_PROBE = 'echo CONDUIT_FAMILY_$((1+1))_%OS%_$PSHOME';
const SH_FAMILY_LINE = 'CONDUIT_FAMILY_2_%OS%_';
const CMD_FAMILY_LINE = 'CONDUIT_FAMILY_$((1+1))_Windows_NT_$PSHOME';

export function parseFamily(stdout: string): ShellFamily | null {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === CMD_FAMILY_LINE) return 'cmd';
    if (line === SH_FAMILY_LINE) return 'sh';
    // PowerShell expands $PSHOME, so its line is the sh line plus a non-empty path.
    if (line.startsWith(SH_FAMILY_LINE) && line.length > SH_FAMILY_LINE.length) return 'powershell';
  }
  return null;
}

// A command is minted only here. The key is a symbol no other module can name, so a hand-written
// `{ command }` is a type error, and sshExec or sshArgv cannot be handed a string that was not built
// by one of this file's builders (plan 4.2.1, spec 8).
const REMOTE: unique symbol = Symbol('RemoteCommand');

/** The single string ssh runs on the remote; it is passed verbatim, never re-quoted. */
export interface RemoteCommand {
  readonly command: string;
  readonly [REMOTE]: true;
}

function remote(command: string): RemoteCommand {
  return { command, [REMOTE]: true };
}

/** The family probe, the one command that runs before the shell family is known. */
export function familyProbeCommand(): RemoteCommand {
  return remote(FAMILY_PROBE);
}

/**
 * Tests only: a raw shell line that is not remote-scripts output, for the ssh plumbing's own tests
 * (sshExec, sshArgv) that drive a stand-in with arbitrary commands. Production code never calls it.
 */
export function remoteForTest(command: string): RemoteCommand {
  return remote(command);
}

export interface ProbeResult {
  os: 'linux' | 'windows' | 'other';
  arch: 'x64' | 'arm64' | 'other';
  home: string;
  userData: string;
  freeBytes: number | null;
  /** Linux only: systemd-logind KillUserProcesses; null = unknown. */
  kup: boolean | null;
  /** Linux only: user linger; null = unknown. */
  linger: boolean | null;
  systemdRun: boolean;
  /** Version dirs under runtime/ that are complete (never .tmp, never conduit-hc). */
  installed: string[];
  /** <userData>/server-version: a hint only; the ensure step's C2 hello is authoritative. */
  recorded: { version: string; linkMajor: number } | null;
  /** AgentCli names with a binary on PATH. */
  agents: string[];
}

export type InstallStep = 'download' | 'checksum' | 'disk' | 'start' | 'unpack';
export type ScriptResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; step: InstallStep; detail: string };

export interface PinFile {
  url: string;
  sha256: string;
  /** Relative to the staging dir: where the pinned file (or the archive's file) lands. */
  dest: string;
  archive?: 'tar.gz' | 'zip';
  stripComponents?: number;
  /** Archive-relative `from` -> `to`, applied after extraction. */
  rename?: Record<string, string>;
}

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

/** How the remote starts the server. The one definition: ensure-args.ts imports it from here. */
export type StartMethod = 'scope' | 'plain' | 'windows-task';

const RESULT_PREFIX = 'CONDUIT_RESULT ';
const INSTALL_STEPS: readonly InstallStep[] = ['download', 'checksum', 'disk', 'start', 'unpack'];
const OSES: readonly ProbeResult['os'][] = ['linux', 'windows', 'other'];
const ARCHES: readonly ProbeResult['arch'][] = ['x64', 'arm64', 'other'];

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isInstallStep = (x: unknown): x is InstallStep => INSTALL_STEPS.some((step) => step === x);

/** The last CONDUIT_RESULT line's JSON; a line that is not JSON counts as no result. */
function resultJson(stdout: string): unknown {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RESULT_PREFIX));
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last.slice(RESULT_PREFIX.length));
  } catch {
    // A truncated or garbled line is the same as no result: the caller reports it as one.
    return undefined;
  }
}

export function parseResultLine(stdout: string): ScriptResult | null {
  const v = resultJson(stdout);
  if (!isRecord(v) || typeof v.ok !== 'boolean') return null;
  if (v.ok) return { ...v, ok: true };
  if (!isInstallStep(v.step) || typeof v.detail !== 'string') return null;
  return { ok: false, step: v.step, detail: v.detail };
}

const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
const boolOrNull = (x: unknown): boolean | null | undefined => {
  if (x === null) return null;
  return typeof x === 'boolean' ? x : undefined;
};
const numberOrNull = (x: unknown): number | null | undefined => {
  if (x === null) return null;
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
};
const stringArray = (x: unknown): string[] | undefined =>
  Array.isArray(x) && x.every((e) => typeof e === 'string') ? x : undefined;
const oneOf = <T extends string>(x: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find((a) => a === x);

function recordedOf(x: unknown): ProbeResult['recorded'] | undefined {
  if (x === null) return null;
  if (!isRecord(x)) return undefined;
  if (typeof x.version !== 'string' || typeof x.linkMajor !== 'number') return undefined;
  return { version: x.version, linkMajor: x.linkMajor };
}

export function parseProbe(stdout: string): ProbeResult | { error: 'bad_probe'; detail: string } {
  const bad = (detail: string) => ({ error: 'bad_probe' as const, detail });
  const v = resultJson(stdout);
  if (!isRecord(v)) return bad('the probe printed no result line');
  if (v.ok !== true) return bad(str(v.detail) ?? 'the probe reported a failure');
  const os = oneOf(v.os, OSES);
  const arch = oneOf(v.arch, ARCHES);
  const home = str(v.home);
  const userData = str(v.userData);
  const freeBytes = numberOrNull(v.freeBytes);
  const kup = boolOrNull(v.kup);
  const linger = boolOrNull(v.linger);
  const systemdRun = typeof v.systemdRun === 'boolean' ? v.systemdRun : undefined;
  const installed = stringArray(v.installed);
  const recorded = recordedOf(v.recorded);
  const agents = stringArray(v.agents);
  if (
    os === undefined ||
    arch === undefined ||
    home === undefined ||
    userData === undefined ||
    freeBytes === undefined ||
    kup === undefined ||
    linger === undefined ||
    systemdRun === undefined ||
    installed === undefined ||
    recorded === undefined ||
    agents === undefined
  ) {
    return bad('a probe field is missing or has the wrong type');
  }
  return {
    os,
    arch,
    home,
    userData,
    freeBytes,
    kup,
    linger,
    systemdRun,
    installed,
    recorded,
    agents,
  };
}

/**
 * How the remote starts the server (decision 4, G7). The survival given here is only the controller's
 * pre-start expectation: hc enables linger itself and keeps its core in user-manager units, so ensure
 * measures the real survival after the start (decision 4, "Measured", bootstrap-smoke.md).
 */
export function startMethodOf(p: ProbeResult): { method: StartMethod; survivesLogout: boolean } {
  if (p.os === 'windows') return { method: 'windows-task', survivesLogout: false };
  if (p.os !== 'linux') return { method: 'plain', survivesLogout: false };
  if (p.linger === true && p.systemdRun) return { method: 'scope', survivesLogout: true };
  if (p.kup === false) return { method: 'plain', survivesLogout: true };
  return { method: 'plain', survivesLogout: false };
}

// ── command builders ──────────────────────────────────────────────────────────

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Base64 values after the script, which the script decodes with `d`. */
function shCommand(script: string, values: readonly string[]): RemoteCommand {
  const argv = values.map((v) => shQuote(b64(v)));
  return remote(['sh', '-c', shQuote(script), 'conduit', ...argv].join(' '));
}

/**
 * The PowerShell values prelude, then the shared header, then the script. The whole text goes
 * in -EncodedCommand as UTF-16LE, so its newlines and quotes never meet a shell.
 */
function psCommand(script: string, values: readonly string[]): RemoteCommand {
  const prelude = `$CONDUIT_ARGS = @(${values.map((v) => `'${b64(v)}'`).join(', ')})`;
  const full = `${prelude}\n${PS_HEADER}\n${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return remote(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  );
}

/** Script text, flush-left and without blank lines, so heredoc terminators match exactly. */
function sh(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

const SH_HEADER = sh(`
  d() { printf '%s' "$1" | base64 -d; }
  ok() { printf 'CONDUIT_RESULT %s\\n' "$1"; exit 0; }
  fail() {
    D=$(printf '%s' "$2" | tr -cd ' -~' | tr -d '"' | tr -d '\\\\')
    printf 'CONDUIT_RESULT {"ok":false,"step":"%s","detail":"%s"}\\n' "$1" "$D"
    exit 1
  }
  sha_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1; else shasum -a 256 < "$1" | cut -d' ' -f1; fi
  }
  size_of() { wc -c < "$1" | tr -d ' '; }
  safe_rel() { case "$1" in ''|/*|*..*|*'\\'*) return 1 ;; esac; return 0; }
  safe_abs() { case "$1" in /*) ;; *) return 1 ;; esac; case "$1" in /|*..*|*'\\'*) return 1 ;; esac; return 0; }
  # rm -rf only ever touches a path under a <v>.tmp folder, so a wrong argument cannot delete a real install.
  guard_tmp() { case "$1" in *.tmp|*.tmp/*) return 0 ;; esac; return 1; }
  have_sha() { command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; }
`);

// The probe reports facts only. It never writes. Its output is JSON built with printf, so the
// home and userData values must be JSON-safe; a quote or backslash there is refused, not escaped.
const SH_PROBE = `${SH_HEADER}
  case "$HOME" in ''|*'"'*|*'\\'*) printf '%s\\n' 'CONDUIT_RESULT {"ok":false,"error":"probe","detail":"HOME is unset or not JSON-safe"}'; exit 1 ;; esac
  UD=$HOME/.config/conduit
  if [ -n "$XDG_CONFIG_HOME" ]; then UD=$XDG_CONFIG_HOME/conduit; fi
  case "$UD" in *'"'*|*'\\'*) printf '%s\\n' 'CONDUIT_RESULT {"ok":false,"error":"probe","detail":"userData is not JSON-safe"}'; exit 1 ;; esac
  case "$(uname -s)" in Linux) OS=linux ;; *) OS=other ;; esac
  # musl is not a supported remote (spec §6): its node and hc builds are glibc-linked.
  if [ "$OS" = linux ] && ldd --version 2>&1 | grep -qi musl; then OS=other; fi
  case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=other ;; esac
  FREEPATH=$UD
  while [ ! -e "$FREEPATH" ] && [ "$FREEPATH" != / ]; do FREEPATH=$(dirname "$FREEPATH"); done
  FREE=$(df -Pk "$FREEPATH" 2>/dev/null | awk 'NR==2 {print $4 * 1024}')
  case "$FREE" in ''|*[!0-9]*) FREE=null ;; esac
  KUP=null
  K=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null)
  case "$K" in 'b true') KUP=true ;; 'b false') KUP=false ;; esac
  LINGER=null
  L=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)
  case "$L" in yes) LINGER=true ;; no) LINGER=false ;; esac
  SDR=false
  if command -v systemd-run >/dev/null 2>&1; then SDR=true; fi
  INST=''
  for DIR in "$UD"/runtime/*/; do
    [ -d "$DIR" ] || continue
    N=$(basename "$DIR")
    case "$N" in *.tmp|*.gc|conduit-hc) continue ;; esac
    if printf '%s' "$N" | grep -Eq '^[0-9][0-9A-Za-z.+-]*$'; then INST="$INST,\\"$N\\""; fi
  done
  INST_JSON="[$(printf '%s' "$INST" | sed 's/^,//')]"
  REC=null
  RF=$UD/server-version
  if [ -f "$RF" ]; then
    RV=$(sed -n 's/.*"version":"\\([0-9A-Za-z.+-]*\\)".*/\\1/p' "$RF" | head -n 1)
    RM=$(sed -n 's/.*"linkMajor":\\([0-9][0-9]*\\).*/\\1/p' "$RF" | head -n 1)
    if [ -n "$RV" ] && [ -n "$RM" ]; then REC="{\\"version\\":\\"$RV\\",\\"linkMajor\\":$RM}"; fi
  fi
  # The Linux installers put their CLIs in ~/.local/bin, which a non-interactive ssh PATH omits, so
  # the lookup adds it (plan decision 4). PATH is restored after the loop.
  AG_PATH=$PATH
  PATH="$HOME/.local/bin:$PATH"
  AG=''
  for P in "$@"; do
    PAIR=$(d "$P")
    CLI=$(printf '%s' "$PAIR" | cut -d: -f1)
    BINS=$(printf '%s' "$PAIR" | cut -d: -f2-)
    FOUND=0
    for BIN in $BINS; do
      if command -v "$BIN" >/dev/null 2>&1; then FOUND=1; break; fi
    done
    if [ "$FOUND" = 1 ]; then AG="$AG,\\"$CLI\\""; fi
  done
  PATH=$AG_PATH
  AG_JSON="[$(printf '%s' "$AG" | sed 's/^,//')]"
  printf 'CONDUIT_RESULT {"ok":true,"os":"%s","arch":"%s","home":"%s","userData":"%s","freeBytes":%s,"kup":%s,"linger":%s,"systemdRun":%s,"installed":%s,"recorded":%s,"agents":%s}\\n' "$OS" "$ARCH" "$HOME" "$UD" "$FREE" "$KUP" "$LINGER" "$SDR" "$INST_JSON" "$REC" "$AG_JSON"
`;

// Pin records are base64 argv: one record per pin, its fields one per line, then one
// `from<TAB>to` line per rename. The download fetches to a scratch file, checks the sha256, and
// only then places it. Any failure removes the whole staging folder.
const SH_DOWNLOAD = `${SH_HEADER}
  ALLOW=$(d "$2")
  STAGING=$(d "$1")
  shift 2
  safe_abs "$STAGING" || fail download "the staging dir is not an absolute, safe path"
  guard_tmp "$STAGING" || fail download "the staging dir is not under a .tmp folder"
  cleanup_fail() { rm -rf "$STAGING"; fail "$1" "$2"; }
  have_sha || cleanup_fail checksum no_sha256_tool
  # Pins are https. A local path is accepted only under the test-only allowLocal=1, and never one
  # that starts with '-' (curl would read it as an option) or carries a scheme.
  pin_url_ok() {
    case "$1" in https://*) return 0 ;; -*) return 1 ;; *://*) return 1 ;; esac
    [ "$ALLOW" = "allowLocal=1" ]
  }
  fetch() {
    case "$1" in
      https://*)
        if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" -- "$1"
        elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" -- "$1"
        else return 1
        fi ;;
      *) cp -- "$1" "$2" ;;
    esac
  }
  rm -rf "$STAGING"
  mkdir -p "$STAGING" || fail download "cannot create the staging folder"
  N=0
  for B in "$@"; do
    N=$((N + 1))
    WORK="$STAGING/.pin-$N"
    REC=$(d "$B") || cleanup_fail download "a pin is not base64"
    URL=$(printf '%s\\n' "$REC" | sed -n 1p)
    SHA=$(printf '%s\\n' "$REC" | sed -n 2p)
    DEST=$(printf '%s\\n' "$REC" | sed -n 3p)
    ARC=$(printf '%s\\n' "$REC" | sed -n 4p)
    STRIP=$(printf '%s\\n' "$REC" | sed -n 5p)
    RENS=$(printf '%s\\n' "$REC" | sed -n '6,$p')
    [ -n "$URL" ] || cleanup_fail download "a pin has no url"
    pin_url_ok "$URL" || cleanup_fail download "a pin URL must be https"
    printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{64}$' || cleanup_fail download "a pin has a malformed sha256"
    safe_rel "$DEST" || cleanup_fail download "a pin has an unsafe dest"
    case "$ARC" in ''|tar.gz|zip) ;; *) cleanup_fail download "a pin names an unknown archive" ;; esac
    [ -n "$STRIP" ] || STRIP=0
    printf '%s' "$STRIP" | grep -Eq '^[0-9]+$' || cleanup_fail download "a pin has a malformed strip count"
    mkdir -p "$WORK/x"
    fetch "$URL" "$WORK/src" || cleanup_fail download "could not fetch $URL"
    [ "$(sha_of "$WORK/src")" = "$SHA" ] || cleanup_fail checksum "sha256 mismatch for $URL"
    if [ -z "$ARC" ]; then
      mkdir -p "$STAGING/$(dirname "$DEST")"
      mv "$WORK/src" "$STAGING/$DEST" || cleanup_fail disk "could not place $DEST"
      chmod 755 "$STAGING/$DEST"
    else
      case "$ARC" in
        tar.gz) tar -xzf "$WORK/src" -C "$WORK/x" --strip-components="$STRIP" || cleanup_fail unpack "could not extract $URL" ;;
        zip) unzip -q -o "$WORK/src" -d "$WORK/x" || cleanup_fail unpack "could not extract $URL" ;;
      esac
      while IFS= read -r LINE; do
        [ -n "$LINE" ] || continue
        FROM=$(printf '%s' "$LINE" | cut -f1)
        TO=$(printf '%s' "$LINE" | cut -f2)
        safe_rel "$FROM" && safe_rel "$TO" || cleanup_fail unpack "a rename is unsafe"
        mkdir -p "$WORK/x/$(dirname "$TO")"
        mv "$WORK/x/$FROM" "$WORK/x/$TO" || cleanup_fail unpack "rename of $FROM failed"
      done <<CONDUIT_RENAMES
$RENS
CONDUIT_RENAMES
      [ -f "$WORK/x/$DEST" ] || cleanup_fail unpack "the archive has no $DEST"
      mkdir -p "$STAGING/$(dirname "$DEST")"
      mv "$WORK/x/$DEST" "$STAGING/$DEST" || cleanup_fail disk "could not place $DEST"
      chmod 755 "$STAGING/$DEST"
    fi
    rm -rf "$WORK"
  done
  ok '{"ok":true}'
`;

// Writes stdin to the path only when its size and sha256 match. Test-independent: the same
// checks serve the push fallback and the bootstrap's own files.
const SH_RECEIVE_FILE = `${SH_HEADER}
  P=$(d "$1")
  SHA=$(d "$2")
  SIZE=$(d "$3")
  safe_abs "$P" || fail unpack "the path is not an absolute, safe path"
  guard_tmp "$P" || fail unpack "the path is not under a .tmp folder"
  have_sha || fail checksum no_sha256_tool
  printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{64}$' || fail checksum "a malformed sha256"
  printf '%s' "$SIZE" | grep -Eq '^[0-9]+$' || fail checksum "a malformed size"
  mkdir -p "$(dirname "$P")" || fail disk "cannot create the folder"
  rm -f "$P" "$P.part"
  cat > "$P.part" || { rm -f "$P.part"; fail disk "cannot write the file"; }
  if [ "$(size_of "$P.part")" != "$SIZE" ]; then rm -f "$P.part"; fail checksum "size mismatch"; fi
  if [ "$(sha_of "$P.part")" != "$SHA" ]; then rm -f "$P.part"; fail checksum "sha256 mismatch"; fi
  chmod 755 "$P.part"
  mv -f "$P.part" "$P" || fail disk "cannot place the file"
  ok '{"ok":true}'
`;

// The manifest is one base64 value, one `sha256<TAB>size<TAB>path` line per file. It is checked
// in full before anything is unpacked, then every file is checked after the tar runs.
const SH_RECEIVE_TREE = `${SH_HEADER}
  D=$(d "$1")
  MAN=$(d "$2")
  safe_abs "$D" || fail unpack "the dir is not an absolute, safe path"
  guard_tmp "$D" || fail unpack "the dir is not under a .tmp folder"
  have_sha || fail checksum no_sha256_tool
  MANPATHS=$(printf '%s\\n' "$MAN" | cut -f3)
  while IFS= read -r L; do
    [ -n "$L" ] || continue
    S=$(printf '%s' "$L" | cut -f1)
    Z=$(printf '%s' "$L" | cut -f2)
    R=$(printf '%s' "$L" | cut -f3)
    printf '%s' "$S" | grep -Eq '^[0-9a-f]{64}$' || fail unpack "a manifest entry has a malformed sha256"
    printf '%s' "$Z" | grep -Eq '^[0-9]+$' || fail unpack "a manifest entry has a malformed size"
    safe_rel "$R" || fail unpack "a manifest entry has an unsafe path"
  done <<CONDUIT_MANIFEST
$MAN
CONDUIT_MANIFEST
  cleanup_fail() { rm -rf "$D"; fail "$1" "$2"; }
  rm -rf "$D"
  mkdir -p "$D" || fail unpack "cannot create the folder"
  tar -x -f - -C "$D" || cleanup_fail unpack "tar could not unpack the stream"
  FOUND=$(find "$D" ! -type d ! -type f | head -n 1)
  if [ -n "$FOUND" ]; then cleanup_fail unpack "the stream holds a link or special file"; fi
  while IFS= read -r L; do
    [ -n "$L" ] || continue
    S=$(printf '%s' "$L" | cut -f1)
    Z=$(printf '%s' "$L" | cut -f2)
    R=$(printf '%s' "$L" | cut -f3)
    if [ ! -f "$D/$R" ] || [ -h "$D/$R" ]; then cleanup_fail unpack "the stream lacks $R"; fi
    [ "$(size_of "$D/$R")" = "$Z" ] || cleanup_fail checksum "size of $R differs from the manifest"
    [ "$(sha_of "$D/$R")" = "$S" ] || cleanup_fail checksum "sha256 of $R differs from the manifest"
  done <<CONDUIT_MANIFEST
$MAN
CONDUIT_MANIFEST
  ACTUAL=$(cd "$D" && find . -type f | sed 's|^\\./||')
  while IFS= read -r R; do
    [ -n "$R" ] || continue
    printf '%s\\n' "$MANPATHS" | grep -Fxq -- "$R" || cleanup_fail unpack "the stream holds $R, which the manifest does not list"
  done <<CONDUIT_ACTUAL
$ACTUAL
CONDUIT_ACTUAL
  ok '{"ok":true}'
`;

// Places <version>.tmp at <version>. If <version> already exists, the staged copy is leftover
// and goes; the rename never replaces a running install.
const SH_FINALIZE = `${SH_HEADER}
  ROOT=$(d "$1")
  V=$(d "$2")
  safe_abs "$ROOT" || fail unpack "the runtime root is not an absolute, safe path"
  printf '%s' "$V" | grep -Eq '^[0-9A-Za-z.+-]+$' || fail unpack "a malformed version"
  case "$V" in .*|*..*) fail unpack "a malformed version" ;; esac
  FINAL="$ROOT/$V"
  TMP="$FINAL.tmp"
  if [ -e "$FINAL" ]; then
    rm -rf "$TMP"
    ok '{"ok":true,"existed":true}'
  fi
  [ -d "$TMP" ] || fail unpack "nothing is staged at the tmp folder"
  mv "$TMP" "$FINAL" || fail unpack "the rename into place failed"
  ok '{"ok":true,"existed":false}'
`;

// The shim dir's node is a copy of the node this version installed, never a second push: the
// copy needs no bytes over ssh, and works on any remote once its own install has succeeded.
const SH_COPY_NODE = `${SH_HEADER}
  ROOT=$(d "$1")
  V=$(d "$2")
  SD=$(d "$3")
  NAME=$(d "$4")
  safe_abs "$ROOT" || fail unpack "the runtime root is not an absolute, safe path"
  safe_abs "$SD" || fail unpack "the shim dir is not an absolute, safe path"
  printf '%s' "$V" | grep -Eq '^[0-9A-Za-z.+-]+$' || fail unpack "a malformed version"
  case "$V" in .*|*..*) fail unpack "a malformed version" ;; esac
  case "$NAME" in node|node.exe) ;; *) fail unpack "an unexpected node name" ;; esac
  SRC="$ROOT/$V/$NAME"
  [ -f "$SRC" ] || fail unpack "node is not installed at $SRC"
  TMP="$SD.tmp"
  [ -d "$TMP" ] || fail unpack "nothing is staged at the shim tmp folder"
  cp "$SRC" "$TMP/$NAME" || fail disk "could not copy node"
  chmod 755 "$TMP/$NAME"
  ok '{"ok":true}'
`;

const PS_COPY_NODE = `
$phase = 'unpack'
$root = Arg 0
$v = Arg 1
$sd = Arg 2
$name = Arg 3
try {
  if (-not (SafeAbs $root)) { throw 'the runtime root is not an absolute, safe path' }
  if (-not (SafeAbs $sd)) { throw 'the shim dir is not an absolute, safe path' }
  if ($v -notmatch '^[0-9A-Za-z.+-]+$' -or $v.StartsWith('.') -or $v.Contains('..')) { throw 'a malformed version' }
  if ($name -ne 'node.exe') { throw 'an unexpected node name' }
  $src = Join-Path (Join-Path $root $v) $name
  if (-not (Test-Path -LiteralPath $src)) { throw "node is not installed at $src" }
  $tmp = "$sd.tmp"
  if (-not (Test-Path -LiteralPath $tmp)) { throw 'nothing is staged at the shim tmp folder' }
  $phase = 'disk'
  Copy-Item -LiteralPath $src -Destination (Join-Path $tmp $name) -Force
  Emit @{ ok = $true }
} catch {
  Fail $phase $_.Exception.Message
}`;

// The ensure step is the installed node running the new headless mode; it prints its own result.
// --survives-logout and --shim-dir are the flags ensure-args.ts parses; --shim-dir is optional.
const SH_ENSURE = `${SH_HEADER}
  NODE=$(d "$1")
  MAIN=$(d "$2")
  UD=$(d "$3")
  M=$(d "$4")
  SV=$(d "$5")
  SD=$(d "$6")
  if [ -n "$SD" ]; then exec "$NODE" "$MAIN" --ensure-server --user-data "$UD" --start "$M" --survives-logout "$SV" --shim-dir "$SD"; fi
  exec "$NODE" "$MAIN" --ensure-server --user-data "$UD" --start "$M" --survives-logout "$SV"
`;

const PS_HEADER = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Arg([int]$i) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CONDUIT_ARGS[$i])) }
function Emit($obj) { Write-Output ('CONDUIT_RESULT ' + (ConvertTo-Json -InputObject $obj -Compress -Depth 4)) }
function Fail([string]$step, [string]$detail) { Emit @{ ok = $false; step = $step; detail = $detail }; exit 1 }
function SafeRel([string]$p) { return ($p -ne '') -and -not $p.StartsWith('/') -and -not $p.Contains('\\') -and -not $p.Contains('..') -and ($p -notmatch '^[A-Za-z]:') }
function SafeAbs([string]$p) { return [IO.Path]::IsPathRooted($p) -and -not $p.Contains('..') }
function TmpOk([string]$p) { return ($p -match '\\.tmp($|[\\\\/])') }
# Windows argv quoting (CommandLineToArgvW): wrap in quotes, double the backslashes that precede a
# quote or the closing quote, and escape each quote. Used for the scheduled task's argument string.
function WinArg([string]$a) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    # [char]92 is a backslash, spelled as a code point so no quoting layer between TS and PowerShell can eat it.
    if ($ch -eq [char]92) { $bs++ }
    elseif ($ch -eq '"') { [void]$sb.Append([char]92, $bs * 2 + 1); [void]$sb.Append('"'); $bs = 0 }
    else { [void]$sb.Append([char]92, $bs); [void]$sb.Append($ch); $bs = 0 }
  }
  [void]$sb.Append([char]92, $bs * 2)
  [void]$sb.Append('"')
  return $sb.ToString()
}`;

// Probe: facts only. It mirrors the sh probe's fields; kup and linger are Linux-only, so null.
const PS_PROBE = `
try {
  $userHome = $env:USERPROFILE
  $ud = Join-Path $env:APPDATA 'conduit'
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { 'other' } }
  $free = $null
  # Free space is measured where userData lives (or its nearest existing parent). It is null when
  # the drive cannot be read: null is the probe's "unknown".
  $freePath = $ud
  while ($freePath -and -not (Test-Path -LiteralPath $freePath)) { $freePath = Split-Path -Parent $freePath }
  try { $free = [IO.DriveInfo]::new($freePath).AvailableFreeSpace } catch { $free = $null }
  $installed = @()
  $rt = Join-Path $ud 'runtime'
  if (Test-Path -LiteralPath $rt) {
    $installed = @(Get-ChildItem -LiteralPath $rt -Directory | Where-Object { $_.Name -match '^[0-9][0-9A-Za-z.+-]*$' -and $_.Name -notlike '*.tmp' -and $_.Name -notlike '*.gc' -and $_.Name -ne 'conduit-hc' } | ForEach-Object { $_.Name })
  }
  $recorded = $null
  $rf = Join-Path $ud 'server-version'
  if (Test-Path -LiteralPath $rf) {
    # A corrupt hint is ignored; the ensure step's C2 hello is what decides.
    try {
      $r = Get-Content -LiteralPath $rf -Raw | ConvertFrom-Json
      $lm = [string]$r.linkMajor
      if (([string]$r.version) -match '^[0-9A-Za-z.+-]+$' -and $lm -match '^[0-9]+$') { $recorded = [ordered]@{ version = [string]$r.version; linkMajor = [int]$lm } }
    } catch { $recorded = $null }
  }
  $agents = @()
  foreach ($p in $CONDUIT_ARGS) {
    $pair = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p))
    $parts = $pair -split ':', 2
    $cli = $parts[0]
    foreach ($b in ($parts[1] -split ' ')) {
      if (Get-Command -Name $b -ErrorAction SilentlyContinue) { $agents += $cli; break }
    }
  }
  $obj = [ordered]@{
    ok = $true; os = 'windows'; arch = $arch; home = $userHome; userData = $ud; freeBytes = $free
    kup = $null; linger = $null; systemdRun = $false
    installed = $installed; recorded = $recorded; agents = $agents
  }
  Write-Output ('CONDUIT_RESULT ' + (ConvertTo-Json -InputObject $obj -Compress -Depth 4))
} catch {
  Write-Output ('CONDUIT_RESULT ' + (ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = 'probe'; detail = $_.Exception.Message }) -Compress))
  exit 1
}`;

const PS_DOWNLOAD = `
$phase = 'download'
$staging = Arg 0
$allow = (Arg 1) -eq 'allowLocal=1'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  if (-not (SafeAbs $staging)) { throw 'the staging dir is not an absolute, safe path' }
  if (-not (TmpOk $staging)) { throw 'the staging dir is not under a .tmp folder' }
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\\tar.exe'
  for ($i = 2; $i -lt $CONDUIT_ARGS.Count; $i++) {
    $lines = @((Arg $i).Split([char]10))
    $url = $lines[0]; $sha = $lines[1]; $dest = $lines[2]; $arc = $lines[3]; $strip = $lines[4]
    $renames = @($lines | Select-Object -Skip 5 | Where-Object { $_ -ne '' })
    if (-not $url) { throw 'a pin has no url' }
    if ($sha -notmatch '^[0-9a-f]{64}$') { throw 'a pin has a malformed sha256' }
    if (-not (SafeRel $dest)) { throw 'a pin has an unsafe dest' }
    if (-not $strip) { $strip = '0' }
    if ($strip -notmatch '^[0-9]+$') { throw 'a pin has a malformed strip count' }
    $work = Join-Path $staging ('.pin-' + $i)
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $src = Join-Path $work 'src'
    $phase = 'download'
    # Pins are https. A local path is accepted only under the test-only allowLocal=1, never one
    # that starts with '-' or carries a scheme.
    if ($url.StartsWith('https://')) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $src }
    elseif ($allow -and -not $url.StartsWith('-') -and -not $url.Contains('://')) { Copy-Item -LiteralPath $url -Destination $src }
    else { throw 'a pin URL must be https' }
    $phase = 'checksum'
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash.ToLowerInvariant() -ne $sha) { throw "sha256 mismatch for $url" }
    $phase = 'unpack'
    if ($arc -eq '') {
      $final = Join-Path $staging $dest
      New-Item -ItemType Directory -Path (Split-Path -Parent $final) -Force | Out-Null
      Move-Item -LiteralPath $src -Destination $final -Force
    } else {
      $x = Join-Path $work 'x'
      New-Item -ItemType Directory -Path $x -Force | Out-Null
      if ($arc -eq 'tar.gz') { & $tar -xzf $src -C $x "--strip-components=$strip" }
      elseif ($arc -eq 'zip') { & $tar -xf $src -C $x }
      else { throw 'a pin names an unknown archive' }
      if ($LASTEXITCODE -ne 0) { throw "could not extract $url" }
      foreach ($r in $renames) {
        $ft = $r.Split([char]9)
        if ($ft.Count -ne 2 -or -not (SafeRel $ft[0]) -or -not (SafeRel $ft[1])) { throw 'a rename is unsafe' }
        $to = Join-Path $x $ft[1]
        New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
        Move-Item -LiteralPath (Join-Path $x $ft[0]) -Destination $to -Force
      }
      $produced = Join-Path $x $dest
      if (-not (Test-Path -LiteralPath $produced)) { throw "the archive has no $dest" }
      $final = Join-Path $staging $dest
      New-Item -ItemType Directory -Path (Split-Path -Parent $final) -Force | Out-Null
      Move-Item -LiteralPath $produced -Destination $final -Force
    }
    Remove-Item -LiteralPath $work -Recurse -Force
  }
  Emit @{ ok = $true }
} catch {
  if ((TmpOk $staging) -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
  Fail $phase $_.Exception.Message
}`;

const PS_RECEIVE_FILE = `
$phase = 'checksum'
$path = Arg 0
$sha = Arg 1
$size = Arg 2
try {
  if (-not (SafeAbs $path)) { throw 'the path is not an absolute, safe path' }
  if (-not (TmpOk $path)) { $phase = 'unpack'; throw 'the path is not under a .tmp folder' }
  if ($sha -notmatch '^[0-9a-f]{64}$') { throw 'a malformed sha256' }
  if ($size -notmatch '^[0-9]+$') { throw 'a malformed size' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
  $part = "$path.part"
  $phase = 'disk'
  # A half-written file from an interrupted run must not survive into the new one.
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
  $in = [Console]::OpenStandardInput()
  $out = [IO.File]::Create($part)
  try { $in.CopyTo($out) } finally { $out.Dispose() }
  $phase = 'checksum'
  if ((Get-Item -LiteralPath $part).Length -ne [int64]$size) { throw 'size mismatch' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash.ToLowerInvariant() -ne $sha) { throw 'sha256 mismatch' }
  $phase = 'disk'
  Move-Item -LiteralPath $part -Destination $path -Force
  Emit @{ ok = $true }
} catch {
  if ((TmpOk $path) -and (Test-Path -LiteralPath "$path.part")) { Remove-Item -LiteralPath "$path.part" -Force }
  Fail $phase $_.Exception.Message
}`;

const PS_RECEIVE_TREE = `
$phase = 'unpack'
$dir = Arg 0
$manText = Arg 1
$created = $false
$tarFile = $null
try {
  if (-not (SafeAbs $dir)) { throw 'the dir is not an absolute, safe path' }
  if (-not (TmpOk $dir)) { throw 'the dir is not under a .tmp folder' }
  $entries = @()
  foreach ($line in @($manText.Split([char]10) | Where-Object { $_ -ne '' })) {
    $f = $line.Split([char]9)
    if ($f.Count -ne 3) { throw 'a manifest entry is malformed' }
    if ($f[0] -notmatch '^[0-9a-f]{64}$') { throw 'a manifest entry has a malformed sha256' }
    if ($f[1] -notmatch '^[0-9]+$') { throw 'a manifest entry has a malformed size' }
    if (-not (SafeRel $f[2])) { throw 'a manifest entry has an unsafe path' }
    $entries += ,$f
  }
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
  $created = $true
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $tarFile = Join-Path (Split-Path -Parent $dir) ('.receive-' + [guid]::NewGuid().ToString('N') + '.tar')
  $in = [Console]::OpenStandardInput()
  $out = [IO.File]::Create($tarFile)
  try { $in.CopyTo($out) } finally { $out.Dispose() }
  $tar = Join-Path $env:SystemRoot 'System32\\tar.exe'
  & $tar -xf $tarFile -C $dir
  $exit = $LASTEXITCODE
  Remove-Item -LiteralPath $tarFile -Force
  $tarFile = $null
  if ($exit -ne 0) { throw 'tar could not unpack the stream' }
  $phase = 'unpack'
  foreach ($e in $entries) {
    $file = Join-Path $dir $e[2]
    $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.PSIsContainer -or (([int]$item.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "the stream lacks $($e[2])" }
    $phase = 'checksum'
    if ($item.Length -ne [int64]$e[1]) { throw "size of $($e[2]) differs from the manifest" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $e[0]) { throw "sha256 of $($e[2]) differs from the manifest" }
    $phase = 'unpack'
  }
  $listed = @{}
  foreach ($e in $entries) { $listed[$e[2]] = $true }
  $root = (Get-Item -LiteralPath $dir).FullName.TrimEnd('\\')
  foreach ($f in Get-ChildItem -LiteralPath $dir -Recurse -Force) {
    if (([int]$f.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'the stream holds a link' }
    if ($f.PSIsContainer) { continue }
    $rel = $f.FullName.Substring($root.Length + 1).Replace('\\', '/')
    if (-not $listed.ContainsKey($rel)) { throw "the stream holds $rel, which the manifest does not list" }
  }
  Emit @{ ok = $true }
} catch {
  if ($tarFile -and (Test-Path -LiteralPath $tarFile)) { Remove-Item -LiteralPath $tarFile -Force }
  if ($created -and (Test-Path -LiteralPath $dir)) { Remove-Item -LiteralPath $dir -Recurse -Force }
  Fail $phase $_.Exception.Message
}`;

const PS_FINALIZE = `
$phase = 'unpack'
try {
  $root = Arg 0
  $v = Arg 1
  if (-not (SafeAbs $root)) { throw 'the runtime root is not an absolute, safe path' }
  if ($v -notmatch '^[0-9A-Za-z.+-]+$' -or $v.StartsWith('.') -or $v.Contains('..')) { throw 'a malformed version' }
  $final = Join-Path $root $v
  $tmp = "$final.tmp"
  if (Test-Path -LiteralPath $final) {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    Emit @{ ok = $true; existed = $true }
  } else {
    if (-not (Test-Path -LiteralPath $tmp)) { throw 'nothing is staged at the tmp folder' }
    Move-Item -LiteralPath $tmp -Destination $final
    Emit @{ ok = $true; existed = $false }
  }
} catch {
  Fail $phase $_.Exception.Message
}`;

// The scheduled task is the windows-task start (decision 5): per user, logon-only, and it runs
// the server's default start. Ensure then only waits for C2 hello, so it never starts a second one.
// The registration is a prelude of the ensure script, present only for that method.
const PS_TASK_START = `
$name = 'ConduitServer'
$argText = (WinArg $sup) + ' --user-data ' + (WinArg $ud) + ' --hc ' + (WinArg $hc)
$action = New-ScheduledTaskAction -Execute $node -Argument $argText
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name`;

const PS_ENSURE_PRELUDE = `
$node = Arg 0
$main = Arg 1
$ud = Arg 2
$method = Arg 3
$sv = Arg 4
$sd = Arg 5
$sup = Arg 6
$hc = Arg 7`;

const PS_ENSURE_RUN = `
$ensureArgs = @('--ensure-server', '--user-data', $ud, '--start', $method, '--survives-logout', $sv)
if ($sd) { $ensureArgs += @('--shim-dir', $sd) }
& $node $main @ensureArgs
exit $LASTEXITCODE`;

// ── public builders ───────────────────────────────────────────────────────────

export function probeCommand(f: ShellFamily): RemoteCommand {
  // Agent CLIs are passed as `cli:bin bin` pairs so the probe's script stays fixed.
  const pairs = AGENT_CLIS.map((cli) => `${cli}:${CLI_BINARIES[cli].join(' ')}`);
  return f === 'sh' ? shCommand(SH_PROBE, pairs) : psCommand(PS_PROBE, pairs);
}

function assertLine(value: string, label: string): void {
  // A newline or tab would split a field of a line-based value, so it cannot be encoded.
  if (/[\n\t]/.test(value)) throw new Error(`${label} must not contain a tab or newline`);
}

function pinRecord(pin: PinFile): string {
  assertLine(pin.url, 'pin url');
  assertLine(pin.sha256, 'pin sha256');
  assertLine(pin.dest, 'pin dest');
  const renames = Object.entries(pin.rename ?? {}).map(([from, to]) => {
    assertLine(from, 'pin rename source');
    assertLine(to, 'pin rename target');
    return `${from}\t${to}`;
  });
  return [
    pin.url,
    pin.sha256,
    pin.dest,
    pin.archive ?? '',
    String(pin.stripComponents ?? 0),
    ...renames,
  ].join('\n');
}

export function downloadCommand(
  f: ShellFamily,
  o: { stagingDir: string; pins: PinFile[]; allowLocal?: boolean },
): RemoteCommand {
  // allowLocal is test-only. A pin URL with no `://` is then copied as a local path, so tests need
  // no network. The bootstrap never sets it: a remote that copies a local path is a remote that
  // trusts whatever file the account can name.
  const flag = o.allowLocal === true ? 'allowLocal=1' : 'allowLocal=0';
  const values = [o.stagingDir, flag, ...o.pins.map(pinRecord)];
  return f === 'sh' ? shCommand(SH_DOWNLOAD, values) : psCommand(PS_DOWNLOAD, values);
}

export function receiveFileCommand(
  f: ShellFamily,
  o: { path: string; sha256: string; size: number },
): RemoteCommand {
  const values = [o.path, o.sha256, String(o.size)];
  return f === 'sh' ? shCommand(SH_RECEIVE_FILE, values) : psCommand(PS_RECEIVE_FILE, values);
}

export function receiveTreeCommand(
  f: ShellFamily,
  o: { dir: string; manifest: ManifestEntry[] },
): RemoteCommand {
  const lines = o.manifest.map((e) => {
    assertLine(e.path, 'manifest path');
    return `${e.sha256}\t${e.size}\t${e.path}`;
  });
  const values = [o.dir, lines.join('\n')];
  return f === 'sh' ? shCommand(SH_RECEIVE_TREE, values) : psCommand(PS_RECEIVE_TREE, values);
}

export function finalizeCommand(
  f: ShellFamily,
  o: { runtimeRoot: string; version: string },
): RemoteCommand {
  const values = [o.runtimeRoot, o.version];
  return f === 'sh' ? shCommand(SH_FINALIZE, values) : psCommand(PS_FINALIZE, values);
}

/** The shim dir's node: a copy of <runtimeRoot>/<version>/node[.exe] into <shimDir>.tmp. */
export function copyNodeIntoShimCommand(
  f: ShellFamily,
  o: { runtimeRoot: string; version: string; shimDir: string },
): RemoteCommand {
  const name = f === 'sh' ? 'node' : 'node.exe';
  const values = [o.runtimeRoot, o.version, o.shimDir, name];
  return f === 'sh' ? shCommand(SH_COPY_NODE, values) : psCommand(PS_COPY_NODE, values);
}

export function ensureCommand(
  f: ShellFamily,
  o: {
    node: string;
    mainJs: string;
    userData: string;
    method: StartMethod;
    /** Decided by the probe (startMethodOf); the ensure result reports it back. */
    survivesLogout: boolean;
    shimDir?: string;
    hcExe?: string;
  },
): RemoteCommand {
  const values = [
    o.node,
    o.mainJs,
    o.userData,
    o.method,
    o.survivesLogout ? 'yes' : 'no',
    o.shimDir ?? '',
  ];
  if (f === 'sh') return shCommand(SH_ENSURE, values);
  // The supervisor is a separate esbuild entry beside main.js, as the app runs it (supervisorArgs).
  if (!o.mainJs.endsWith('main.js')) throw new Error(`mainJs must be the server's main.js`);
  const superviseJs = o.mainJs.slice(0, -'main.js'.length) + 'supervise.js';
  if (o.method === 'windows-task' && o.hcExe === undefined) {
    throw new Error('the windows-task start needs the hc executable');
  }
  // cmd.exe caps a command line at 8191 characters, and these -EncodedCommand scripts may exceed it. Pending a Windows box.
  const psValues = [...values, superviseJs, o.hcExe ?? ''];
  const script =
    o.method === 'windows-task'
      ? `${PS_ENSURE_PRELUDE}\n${PS_TASK_START}\n${PS_ENSURE_RUN}`
      : `${PS_ENSURE_PRELUDE}\n${PS_ENSURE_RUN}`;
  return psCommand(script, psValues);
}
