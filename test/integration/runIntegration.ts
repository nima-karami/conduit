import { runTests } from '@vscode/test-electron';
import * as path from 'path';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './extension.test.js');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ['--disable-extensions'],
  });
}

main().catch((e) => {
  console.error('Integration tests failed:', e);
  process.exit(1);
});
