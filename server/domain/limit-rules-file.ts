import { join } from 'node:path';
import type { watchDir } from '../../electron/watch-dir';
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

  const load = (): void => {
    const text = deps.fs.read(file);
    if (text === null) {
      const seed = `${JSON.stringify({ version: 1, rules: DEFAULT_LIMIT_RULES }, null, 2)}\n`;
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
      // the file is the user's to fix; it is left as written and the defaults serve in the meantime
      deps.log.warn('limit rules file is unreadable; using the defaults', {
        file,
        error: String(err),
      });
      compiled = defaults();
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

  load();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const watch = deps.watchDir(
    deps.userData,
    {},
    (_event, name) => {
      if (name !== null && name !== FILE_NAME) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        load();
        deps.onChange();
      }, RELOAD_DEBOUNCE_MS);
    },
    (error) => {
      if (error) deps.log.warn('limit rules folder watch failed', { error: String(error) });
    },
  );

  return {
    current() {
      return compiled;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      watch.close();
    },
  };
}
