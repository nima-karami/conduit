import { type LanguageId, langFromPath } from '../src/lang';

/** Fence names that `block.<fence>` can't resolve: the language is keyed by a file NAME
 *  (`Makefile`, `.gitignore`) or the fence is its common alias. */
const FENCES: Readonly<Record<string, LanguageId>> = {
  makefile: 'makefile',
  make: 'makefile',
  cmake: 'cmake',
  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
  dotenv: 'dotenv',
  env: 'dotenv',
  gitignore: 'ignore',
  groovy: 'groovy',
  ocaml: 'ocaml',
};

/** Monaco language id for a plan code fence. Reuses `src/lang.ts`'s extension table rather than
 *  a second copy of it; a fence that is already a Monaco id (`javascript`, `shell`) passes
 *  through untranslated. */
export function planFenceLanguage(fence: string): string {
  if (!fence) return 'plaintext';
  if (Object.hasOwn(FENCES, fence)) return FENCES[fence];
  const mapped = langFromPath(`block.${fence}`);
  return mapped === 'plaintext' ? fence : mapped;
}
