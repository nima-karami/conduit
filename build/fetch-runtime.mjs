/**
 * See ADR 0007, W9: pinned runtimes are fetched at build time, never committed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function httpDownload(url, file) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`GET ${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
}

async function systemExtractZip(zip, dir) {
  await mkdir(dir, { recursive: true });
  // Windows' own bsdtar opens zips; a Git Bash tar earlier on PATH can't.
  if (process.platform === 'win32') {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await promisify(execFile)(tar, ['-xf', zip, '-C', dir]);
  } else {
    await promisify(execFile)('unzip', ['-q', zip, '-d', dir]);
  }
}

async function systemExtractTar(archive, dir, stripComponents = 0) {
  await mkdir(dir, { recursive: true });
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  await promisify(execFile)(tar, [
    '-xf',
    archive,
    '-C',
    dir,
    `--strip-components=${stripComponents}`,
  ]);
}

/** Downloads to `<file>`, and deletes it again unless its sha256 is the pinned one. */
async function downloadVerified(pin, file, download) {
  await rm(file, { force: true });
  try {
    await download(pin.url, file);
    const got = await sha256File(file);
    if (got !== pin.sha256) {
      throw new Error(`${pin.url}: sha256 ${got}, pinned ${pin.sha256}`);
    }
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

/**
 * The one binary an archive pin yields: its single rename target. binSha256 names that file, so a
 * pin that asks for it must rename exactly one.
 */
function binaryOf(pin) {
  const names = Object.values(pin.rename ?? {});
  if (names.length !== 1) {
    throw new Error(`${pin.url}: a pin with binSha256 must rename exactly one binary`);
  }
  return names[0];
}

/**
 * A file pin is verified in place. An archive pin is verified as downloaded, then extracted, and its
 * binary is checked against binSha256 when the pin has one (spec 5.5: the push verifies against it).
 * `<dest>.sha256` records which archive the dir came from, so it sits beside the dir and is never
 * packaged with it.
 */
export async function ensurePinned(pin, deps) {
  const download = deps.download ?? httpDownload;
  const target = join(deps.vendorDir, pin.dest);

  if (!pin.archive) {
    if ((await exists(target)) && (await sha256File(target)) === pin.sha256) return 'skipped';
    await mkdir(dirname(target), { recursive: true });
    await downloadVerified(pin, `${target}.tmp`, download);
    await rename(`${target}.tmp`, target);
    return 'fetched';
  }

  const bin = pin.binSha256 === undefined ? null : binaryOf(pin);
  const binMatches = async (dir) =>
    bin === null ||
    ((await exists(join(dir, bin))) && (await sha256File(join(dir, bin))) === pin.binSha256);

  const stamp = `${target}.sha256`;
  if ((await exists(target)) && (await exists(stamp))) {
    // Archive hashes survive packaging layout changes (e.g. hc -> conduit-hc).
    const renamedFiles = await Promise.all(
      Object.values(pin.rename ?? {}).map((file) => exists(join(target, file))),
    );
    if (
      (await readFile(stamp, 'utf8')).trim() === pin.sha256 &&
      renamedFiles.every(Boolean) &&
      (await binMatches(target))
    )
      return 'skipped';
  }
  const archive = `${target}.${pin.archive}.tmp`;
  const staging = `${target}.tmp`;
  await mkdir(deps.vendorDir, { recursive: true });
  await downloadVerified(pin, archive, download);
  try {
    await rm(staging, { recursive: true, force: true });
    if (pin.archive === 'tar.gz') {
      await (deps.extractTar ?? systemExtractTar)(archive, staging, pin.stripComponents ?? 0);
    } else {
      await (deps.extractZip ?? systemExtractZip)(archive, staging);
    }
    for (const [from, to] of Object.entries(pin.rename ?? {})) {
      await rename(join(staging, from), join(staging, to));
    }
    if (!(await binMatches(staging))) {
      throw new Error(`${pin.url}: extracted ${bin} does not match binSha256 ${pin.binSha256}`);
    }
    await rm(stamp, { force: true });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await writeFile(stamp, `${pin.sha256}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
  return 'fetched';
}

export async function fetchRuntime({
  pins,
  platform = process.platform,
  arch = process.arch,
  log = console.log,
  ...deps
}) {
  const selected = pins[`${platform}-${arch}`];
  if (!selected) throw new Error(`No pinned runtime for ${platform}-${arch}`);
  for (const [name, pin] of Object.entries(selected)) {
    const result = await ensurePinned(pin, deps);
    log(`${name} ${pin.version}: ${result}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pins = JSON.parse(await readFile(join(here, 'runtime-pins.json'), 'utf8'));
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--platform', '--arch'].includes(flag) || !args[0] || args[0].startsWith('--')) {
      throw new Error(
        'Usage: node build/fetch-runtime.mjs [--platform darwin|linux|win32] [--arch arm64|x64]',
      );
    }
    options[flag.slice(2)] = args.shift();
  }
  await fetchRuntime({ pins, vendorDir: join(here, 'vendor'), ...options });
}
