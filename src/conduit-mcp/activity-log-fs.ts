import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import { ACTIVITY_MAX_BYTES, type ActivityIo } from './activity-log';
import { isActivityDay } from './activity-query';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function createActivityIo(dir: string): ActivityIo {
  const activityDir = path.join(dir, 'activity');
  const dayFile = (day: string): string => {
    if (!isActivityDay(day)) throw new Error('Invalid Activity day');
    return path.join(activityDir, `${day}.jsonl`);
  };
  const argsFile = path.join(activityDir, 'ask-args.json');
  return {
    append(day, line) {
      fs.mkdirSync(activityDir, { recursive: true });
      fs.appendFileSync(dayFile(day), line);
    },
    read(day, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ACTIVITY_MAX_BYTES) {
        throw new Error('Invalid Activity read budget');
      }
      const fd = fs.openSync(dayFile(day), 'r');
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > maxBytes)
          throw new Error('Activity day exceeds read budget');
        const chunks: Buffer[] = [];
        let total = 0;
        while (total <= maxBytes) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (bytes === 0) break;
          total += bytes;
          if (total > maxBytes) throw new Error('Activity day exceeds read budget');
          chunks.push(buffer.subarray(0, bytes));
        }
        return Buffer.concat(chunks, total).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    },
    list() {
      let names: string[];
      try {
        names = fs.readdirSync(activityDir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const days: Array<{ day: string; bytes: number }> = [];
      for (const name of names) {
        if (!DAY_FILE.test(name)) continue;
        try {
          days.push({
            day: name.slice(0, -'.jsonl'.length),
            bytes: fs.statSync(path.join(activityDir, name)).size,
          });
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      return days;
    },
    remove(day) {
      fs.unlinkSync(dayFile(day));
    },
    readArgs() {
      try {
        return fs.readFileSync(argsFile, 'utf8');
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    writeArgs(text) {
      fs.mkdirSync(activityDir, { recursive: true });
      atomicWriteFileSync(argsFile, text);
    },
  };
}
