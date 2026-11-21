import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, profileDir, runScenario } from './harness.mjs';

const userDataDir = profileDir('file-manager');
const root = join(userDataDir, 'integration');
const registryRoot = 'HKCU\\Software\\ConduitE2E\\Software';
const folderKey = `${registryRoot}\\Classes\\Directory\\shell\\Conduit\\command`;
const registered = `${registryRoot}\\RegisteredApplications`;
const reg = (...args) => spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
const appImage = join(root, 'Conduit é "preview".AppImage');
const present = () =>
  process.platform === 'win32'
    ? [
        reg('query', folderKey, '/ve').status === 0,
        reg('query', registered, '/v', 'Conduit').status === 0,
      ]
    : [
        'data/nautilus-python/extensions/conduit.py',
        'data/kio/servicemenus/conduit.desktop',
        'data/nemo/actions/conduit.nemo_action',
        'config/Thunar/uca.xml',
      ].map((file) => existsSync(join(root, file)));

await runScenario(
  'file-manager-integration',
  async ({ page, log }) => {
    await page.click('.footbtn[title^="Settings"]');
    await page.getByText('General', { exact: true }).click();
    const control = page.getByRole('switch', { name: 'Open in Conduit from the file manager' });
    const off = control.and(page.getByRole('switch', { checked: false }));
    const on = control.and(page.getByRole('switch', { checked: true }));
    await off.waitFor();
    assert(
      present().every((entry) => !entry),
      'isolated integration starts empty',
    );

    try {
      await off.click();
      await on.waitFor();
      assert(present().every(Boolean), 'the on click installs file manager integration');
      if (process.platform === 'win32') {
        assert(reg('query', folderKey, '/ve').stdout.includes('"%1"'), 'registry quotes the path');
      } else {
        const extension = join(root, 'data/nautilus-python/extensions/conduit.py');
        assert(readFileSync(extension, 'utf8').includes(JSON.stringify(appImage)), 'uses APPIMAGE');
      }
      log('On click installed isolated integration');

      await on.click();
      await off.waitFor();
      assert(
        present().every((entry) => !entry),
        'the off click removes file manager integration',
      );
      if (process.platform === 'linux') {
        assert(existsSync(join(root, 'config/Conduit/file-manager-off')), 'off marker is present');
      }
      log('Off click removed isolated integration');
    } finally {
      if (process.platform === 'win32') reg('delete', registryRoot, '/f');
    }
  },
  {
    env: {
      CONDUIT_OS_INTEGRATION_ROOT: root,
      ...(process.platform === 'linux' ? { APPIMAGE: appImage } : {}),
    },
    userDataDir,
  },
);
