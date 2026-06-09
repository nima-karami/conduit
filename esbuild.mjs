import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

const host = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'node-pty'],
};

const web = {
  ...common,
  entryPoints: ['webview/index.tsx'],
  outfile: 'out/webview.js',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
};

const integration = {
  ...common,
  entryPoints: ['test/integration/runIntegration.ts', 'test/integration/extension.test.ts'],
  outdir: 'out/test/integration',
  platform: 'node',
  format: 'cjs',
  external: ['vscode', '@vscode/test-electron', 'mocha', 'node-pty'],
};

if (watch) {
  const c1 = await esbuild.context(host);
  const c2 = await esbuild.context(web);
  await c1.watch();
  await c2.watch();
} else {
  await esbuild.build(host);
  await esbuild.build(web);
  await esbuild.build(integration);
}
