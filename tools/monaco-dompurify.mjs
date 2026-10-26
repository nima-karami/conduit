import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Monaco vendors its own DOMPurify copy (pinned 3.2.7, high-severity advisories) and npm
// can't patch a vendored file; send its import to the audited `dompurify` package instead.
export const monacoDompurify = {
  name: 'monaco-dompurify',
  setup(build) {
    build.onResolve({ filter: /^\.\/dompurify\/dompurify\.js$/ }, (args) => {
      if (!/[\\/]monaco-editor[\\/]/.test(args.importer)) return undefined;
      return build.resolve('dompurify', { kind: args.kind, resolveDir: repoRoot });
    });
  },
};
