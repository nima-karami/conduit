/**
 * Linux process table from /proc, for the e2e harness and runner. Pure apart from the injected
 * fs calls, so the parsing is unit-tested without touching the real process list.
 */
import { readdirSync, readFileSync } from 'node:fs';

/**
 * One `/proc/<pid>/stat` line. comm is in parentheses and may contain spaces and parentheses, so
 * it runs from the first "(" to the LAST ")"; the fields after it start with the state, then ppid.
 * @param {string} text
 * @returns {{ pid: number, ppid: number, comm: string } | null}
 */
export function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const ppid = Number(
    text
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1],
  );
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, comm: text.slice(open + 1, close) };
}

/**
 * Every numeric /proc entry, with its ppid, comm and command line (NULs as spaces). An entry that
 * exits between the listing and the reads is skipped, not an error.
 * @param {{ readdir?: (p: string) => string[], readFile?: (p: string, enc: 'utf8') => string }} [io]
 * @returns {{ pid: number, ppid: number, comm: string, cmdline: string | null }[]}
 */
export function readProcTable({ readdir = readdirSync, readFile = readFileSync } = {}) {
  const rows = [];
  for (const entry of readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = parseStat(readFile(`/proc/${entry}/stat`, 'utf8'));
      if (!stat) continue;
      const cmdline = readFile(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trimEnd();
      rows.push({ ...stat, cmdline });
    } catch {
      /* exited mid-scan */
    }
  }
  return rows;
}

/**
 * Every descendant of `rootPid` (not the root), breadth-first. `visited` makes a ppid cycle, which
 * pid reuse can produce, terminate.
 * @param {number} rootPid
 * @param {{ pid: number, ppid: number }[]} table
 * @returns {number[]}
 */
export function descendantsOf(rootPid, table) {
  const children = new Map();
  for (const p of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const visited = new Set([rootPid]);
  const out = [];
  for (let queue = [rootPid]; queue.length; ) {
    const next = [];
    for (const pid of queue) {
      for (const child of children.get(pid) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        out.push(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return out;
}

/**
 * Rows whose command line contains any needle. A row with no readable command line never matches.
 * @param {{ cmdline: string | null }[]} table
 * @param {string[]} needles
 */
export function findByCmdline(table, needles) {
  return table.filter((p) => p.cmdline !== null && needles.some((n) => p.cmdline.includes(n)));
}

/**
 * SIGKILL a process tree on Linux: the descendants leaves-first, then the root, so a child cannot
 * be reparented before its collection. Descendants are read before any signal is sent. A pid that
 * has already exited is skipped. Returns the pids signalled.
 * @param {number} rootPid
 * @param {{ readTable?: () => { pid: number, ppid: number }[], kill?: (pid: number) => void }} [o]
 * @returns {number[]}
 */
export function killTree(
  rootPid,
  { readTable = () => readProcTable(), kill = (pid) => process.kill(pid, 'SIGKILL') } = {},
) {
  const order = [...descendantsOf(rootPid, readTable()).reverse(), rootPid];
  const killed = [];
  for (const pid of order) {
    try {
      kill(pid);
      killed.push(pid);
    } catch {
      /* already gone */
    }
  }
  return killed;
}
