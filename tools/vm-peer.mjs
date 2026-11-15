#!/usr/bin/env node
// Tier 2 peer for cross-machine Conduit (docs/runs/2026-11-14-CON-27/test-env.md): one Ubuntu cloud
// VM under QEMU/KVM, headless, with only 127.0.0.1 port forwards. Usage:
//   node tools/vm-peer.mjs up | down | pause | resume | status | ssh -- <command…>
// State lives in $CONDUIT_VM_DIR (default ~/.cache/conduit-vm/con27), never /tmp: its quota is
// shared. The image comes only from cloud-images.ubuntu.com and is checked against the published
// SHA256SUMS before first boot. `down` stops QEMU by the PID it wrote, never by name.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.CONDUIT_VM_DIR ?? join(homedir(), '.cache', 'conduit-vm', 'con27');
const BASE_URL = 'https://cloud-images.ubuntu.com/releases/26.04/release/';
const IMAGE = 'ubuntu-26.04-server-cloudimg-amd64.img';
/** Host-side loopback ports QEMU forwards into the guest. */
export const PORTS = { ssh: 47422, link: 47491, pairing: 47492 };
/** Guest-side Conduit ports (networkPort and networkPort + 1). */
export const GUEST = { link: 47391, pairing: 47392 };

const p = (name) => join(DIR, name);
const log = (...a) => console.log('[vm-peer]', ...a);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function fetchImage() {
  mkdirSync(DIR, { recursive: true });
  const sums = execFileSync('curl', ['-fsSL', `${BASE_URL}SHA256SUMS`], { encoding: 'utf8' });
  const line = sums.split('\n').find((l) => l.trim().endsWith(`*${IMAGE}`));
  const expected = line?.split(/\s+/)[0];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('no SHA256 for the image');
  const image = p(IMAGE);
  if (!existsSync(image)) {
    log(`downloading ${IMAGE}`);
    execFileSync(
      'curl',
      ['-fL', '--proto', '=https', '-o', `${image}.part`, `${BASE_URL}${IMAGE}`],
      {
        stdio: 'inherit',
      },
    );
    execFileSync('mv', [`${image}.part`, image]);
  }
  const actual = await sha256(image);
  if (actual !== expected) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
  log(`image verified ${actual}`);
  return image;
}

function seed() {
  if (!existsSync(p('id_ed25519')))
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', p('id_ed25519')]);
  const pub = readFileSync(p('id_ed25519.pub'), 'utf8').trim();
  const dir = p('seed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta-data'),
    'instance-id: conduit-con27\nlocal-hostname: conduit-peer\n',
  );
  writeFileSync(
    join(dir, 'user-data'),
    `#cloud-config\nusers:\n  - name: conduit\n    shell: /bin/bash\n    lock_passwd: true\n    ssh_authorized_keys:\n      - ${pub}\nssh_pwauth: false\npackage_update: false\n`,
  );
  execFileSync('xorriso', [
    '-as',
    'mkisofs',
    '-quiet',
    '-output',
    p('seed.iso'),
    '-volid',
    'cidata',
    '-joliet',
    '-rock',
    join(dir, 'user-data'),
    join(dir, 'meta-data'),
  ]);
}

const pid = () => (existsSync(p('qemu.pid')) ? Number(readFileSync(p('qemu.pid'), 'utf8')) : null);
const alive = (n) => {
  if (!n) return false;
  try {
    process.kill(n, 0);
    // The PID file could outlive QEMU; only signal a process that is still our QEMU.
    return readFileSync(`/proc/${n}/cmdline`, 'utf8').includes(p('disk.qcow2'));
  } catch {
    return false;
  }
};

async function up() {
  if (alive(pid())) return log(`already running, pid ${pid()}`);
  const image = await fetchImage();
  if (!existsSync(p('disk.qcow2')))
    execFileSync('qemu-img', [
      'create',
      '-q',
      '-f',
      'qcow2',
      '-F',
      'qcow2',
      '-b',
      image,
      p('disk.qcow2'),
      '8G',
    ]);
  seed();
  const fwd = [
    `hostfwd=tcp:127.0.0.1:${PORTS.ssh}-:22`,
    `hostfwd=tcp:127.0.0.1:${PORTS.link}-:${GUEST.link}`,
    `hostfwd=tcp:127.0.0.1:${PORTS.pairing}-:${GUEST.pairing}`,
  ].join(',');
  const child = spawn(
    'qemu-system-x86_64',
    [
      '-enable-kvm',
      '-m',
      '2048',
      '-smp',
      '2',
      // No window, no VNC, no serial console on a terminal: nothing can take focus.
      '-display',
      'none',
      '-vga',
      'none',
      '-serial',
      `file:${p('serial.log')}`,
      '-monitor',
      'none',
      '-drive',
      `file=${p('disk.qcow2')},if=virtio`,
      '-drive',
      `file=${p('seed.iso')},if=virtio,media=cdrom,readonly=on`,
      '-nic',
      `user,model=virtio-net-pci,${fwd}`,
      '-qmp',
      `unix:${p('qmp.sock')},server=on,wait=off`,
      '-pidfile',
      p('qemu.pid'),
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 100 && !alive(pid()); i++) await new Promise((r) => setTimeout(r, 100));
  if (!alive(pid())) throw new Error('QEMU did not start; see serial.log');
  log(`started pid ${pid()}; waiting for ssh`);
  for (let i = 0; i < 120; i++) {
    if (ssh(['true'], { quiet: true }).status === 0) return log('ssh ready');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('ssh never came up');
}

export function sshArgs() {
  return [
    '-i',
    p('id_ed25519'),
    '-p',
    String(PORTS.ssh),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${p('known_hosts')}`,
    '-o',
    'ConnectTimeout=5',
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
    'conduit@127.0.0.1',
  ];
}

function ssh(cmd, { quiet = false } = {}) {
  return spawnSync('ssh', [...sshArgs(), ...cmd], { stdio: quiet ? 'ignore' : 'inherit' });
}

function qmp(command) {
  return new Promise((resolve, reject) => {
    const sock = connect(p('qmp.sock'));
    let buf = '';
    let step = 0;
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.event) continue;
        if (step === 0) sock.write('{"execute":"qmp_capabilities"}\n');
        else if (step === 1) sock.write(`${JSON.stringify({ execute: command })}\n`);
        else {
          sock.end();
          if (msg.error) reject(new Error(msg.error.desc));
          else resolve(msg.return);
        }
        step += 1;
      }
    });
    sock.on('error', reject);
  });
}

async function down() {
  const n = pid();
  if (!alive(n)) return log('not running');
  try {
    await qmp('quit');
  } catch {
    process.kill(n, 'SIGTERM');
  }
  for (let i = 0; i < 50 && alive(n); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(n)) process.kill(n, 'SIGKILL');
  log(`stopped pid ${n}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = {
  up,
  down,
  pause: () => qmp('stop').then(() => log('paused')),
  resume: () => qmp('cont').then(() => log('resumed')),
  status: () => log(alive(pid()) ? `running, pid ${pid()}` : 'not running', `dir ${DIR}`),
  ssh: () => process.exit(ssh(rest[0] === '--' ? rest.slice(1) : rest).status ?? 1),
}[cmd ?? ''];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!run) {
    console.error('usage: node tools/vm-peer.mjs up|down|pause|resume|status|ssh -- <cmd>');
    process.exit(2);
  }
  Promise.resolve()
    .then(run)
    .catch((e) => {
      console.error('[vm-peer]', e.message);
      process.exit(1);
    });
}
