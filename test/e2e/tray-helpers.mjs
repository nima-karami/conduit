import { appendFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const seamOut = (dir) => join(dir, 'tray-seam.jsonl');
export const seamIn = (dir) => join(dir, 'tray-seam-in.jsonl');

export async function waitForLine(file, predicate, ms = 30000, after = 0) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = after; i < lines.length; i++) {
      if (predicate(lines[i])) return { line: lines[i], next: i + 1 };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for a line in ${file}`);
}

export function matchesMessage(line, direction, predicate) {
  try {
    const record = JSON.parse(line);
    return record.dir === direction && predicate(record.message);
  } catch {
    return false;
  }
}

export async function waitForMessage(dir, direction, predicate, ms, after = 0) {
  const found = await waitForLine(
    seamOut(dir),
    (line) => matchesMessage(line, direction, predicate),
    ms,
    after,
  );
  return { ...found, message: JSON.parse(found.line).message };
}

export async function injectStop(dir) {
  let before = 0;
  try {
    before = (await readFile(seamOut(dir), 'utf8')).split(/\r?\n/).filter(Boolean).length;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await appendFile(seamIn(dir), `${JSON.stringify({ type: 'stopAll' })}\n`);
  try {
    await waitForMessage(dir, 'in', (message) => message.type === 'stopAll', 10000, before);
  } finally {
    await unlink(seamIn(dir)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function waitUntil(predicate, description, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
