import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import type { ActivityIo } from './activity-log';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function createActivityIo(dir: string): ActivityIo {
  const activityDir = path.join(dir, 'activity');
  const dayFile = (day: string): string => path.join(activityDir, `${day}.jsonl`);
  const argsFile = path.join(activityDir, 'ask-args.json');
  return {
    append(day, line) {
      fs.mkdirSync(activityDir, { recursive: true });
      fs.appendFileSync(dayFile(day), line);
    },
    list() {
      let names: string[];
      try {
        names = fs.readdirSync(activityDir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      return names
        .filter((name) => DAY_FILE.test(name))
        .map((name) => ({
          day: name.slice(0, -'.jsonl'.length),
          bytes: fs.statSync(path.join(activityDir, name)).size,
        }));
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
