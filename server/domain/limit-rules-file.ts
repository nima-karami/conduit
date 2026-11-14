import { join } from 'node:path';
import { type DirWatch, EXISTS_POLL_MS, type watchDir } from '../../electron/watch-dir';
import { SERVER_FILE_VERSION } from '../../src/contracts/session-identity';
import {
  type CompiledRules,
  compileLimitRules,
  DEFAULT_LIMIT_RULES,
  parseLimitRulesFile,
} from '../../src/limit-rules';

const FILE_NAME = 'limit-rules.json';
const RELOAD_DEBOUNCE_MS = 250;

export interface LimitRulesSource {
  current(): CompiledRules;
  dispose(): void;
}

export function createLimitRulesSource(deps: {
  userData: string;
  watchDir: typeof watchDir;
  fs: { read(p: string): string | null; writeAtomic(p: string, data: string): void };
  onChange(): void;
  log: { info(msg: string, data?: object): void; warn(msg: string, data?: object): void };
}): LimitRulesSource {
  const file = join(deps.userData, FILE_NAME);
  const defaults = (): CompiledRules => compileLimitRules(DEFAULT_LIMIT_RULES);
  let compiled = defaults();

  // Only the first load may fall back to the defaults. A reload keeps the rules the user already
  // has when the file goes bad, so an editing slip never silently drops them.
  const load = (initial: boolean): void => {
    const reject = (message: string, data: object): void => {
      deps.log.warn(message, { file, ...data });
      if (initial) compiled = defaults();
    };
    let text: string | null;
    try {
      text = deps.fs.read(file);
    } catch (err) {
      reject('limit rules file is unreadable', { error: String(err) });
      return;
    }
    if (text === null) {
      if (!initial) {
        reject('limit rules file is missing; keeping the current rules', {});
        return;
      }
      const seed = `${JSON.stringify({ version: SERVER_FILE_VERSION[FILE_NAME], rules: DEFAULT_LIMIT_RULES }, null, 2)}\n`;
      try {
        deps.fs.writeAtomic(file, seed);
        deps.log.info('created limit rules file', { file });
      } catch (err) {
        deps.log.warn('could not create limit rules file; using the defaults', {
          file,
          error: String(err),
        });
      }
      compiled = defaults();
      return;
    }
    let parsed: ReturnType<typeof parseLimitRulesFile>;
    try {
      parsed = parseLimitRulesFile(text);
    } catch (err) {
      reject('limit rules file is corrupt', { error: String(err) });
      return;
    }
    if (parsed.version === 'newer') {
      reject('limit rules file was written by a newer version; the file is left as it is', {});
      return;
    }
    for (const rule of parsed.invalid) {
      deps.log.warn('limit rule excluded', { file, id: rule.id, error: rule.error });
    }
    compiled = compileLimitRules(parsed.rules);
    for (const rule of compiled.invalid) {
      deps.log.warn('limit rule excluded', { file, id: rule.id, error: rule.error });
    }
  };

  load(true);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watch: DirWatch | null = null;
  let rearm: ReturnType<typeof setTimeout> | null = null;
  let unwatched = false;
  let warnedWatch = false;
  let disposed = false;

  const onEvent = (_event: string, name: string | null): void => {
    if (name !== null && name !== FILE_NAME) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      load(false);
      deps.onChange();
    }, RELOAD_DEBOUNCE_MS);
  };

  const scheduleRearm = (): void => {
    unwatched = true;
    if (disposed || rearm) return;
    rearm = setTimeout(() => {
      rearm = null;
      arm();
    }, EXISTS_POLL_MS);
  };

  // A reload after an unwatched gap picks up what changed meanwhile: the watch cannot replay it.
  const arm = (): void => {
    if (disposed) return;
    try {
      watch = deps.watchDir(deps.userData, {}, onEvent, (error) => {
        watch = null;
        if (error) deps.log.warn('limit rules folder watch failed', { error: String(error) });
        scheduleRearm();
      });
    } catch (err) {
      if (!warnedWatch) {
        warnedWatch = true;
        deps.log.warn('could not watch limit rules folder; retrying', { error: String(err) });
      }
      scheduleRearm();
      return;
    }
    warnedWatch = false;
    if (!unwatched) return;
    unwatched = false;
    load(false);
    deps.onChange();
  };

  arm();

  return {
    current() {
      return compiled;
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (rearm) clearTimeout(rearm);
      timer = null;
      rearm = null;
      watch?.close();
    },
  };
}
