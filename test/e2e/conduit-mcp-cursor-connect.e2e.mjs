/** Cursor Settings opt-in writes only to the injected home and removes its entry on disconnect. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assert, profileDir, runScenario } from './harness.mjs';

const userDataDir = profileDir('cursor-connect');
const homeDir = join(userDataDir, 'injected-home');
const configPath = join(homeDir, '.cursor', 'mcp.json');
const normalizePath = (value) => {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

await runScenario(
  'conduit-mcp-cursor-connect',
  async ({ app, page, log }) => {
    try {
      await page.locator('.footbtn[title^="Settings"]').click();
      const cursor = page.locator('.modal.settings .set').filter({
        has: page.locator('.set__title', { hasText: 'Cursor' }),
      });
      const status = cursor.locator('[role="status"]');
      await status.getByText('Not connected', { exact: true }).waitFor({ timeout: 10_000 });
      const runtimeHome = await app.evaluate(() => require('node:os').homedir());
      assert(
        normalizePath(runtimeHome) === normalizePath(homeDir),
        `Electron homedir ${runtimeHome} should match injected home ${homeDir}`,
      );
      const hostConnection = await page.evaluate(async () =>
        window.agentDeck.readCursorConnection(),
      );
      assert(
        normalizePath(hostConnection.path) === normalizePath(configPath),
        `Host config path ${hostConnection.path} should match ${configPath}`,
      );
      log('Electron and host both use the injected Cursor home ✓');
      log('Settings starts disconnected in the injected home ✓');

      await cursor.getByRole('button', { name: 'Connect Cursor' }).click();
      await status.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 });
      assert(existsSync(configPath), `Connect should create ${configPath}`);

      const expected = await app.evaluate(({ app: electronApp }) => {
        const separator = process.platform === 'win32' ? '\\' : '/';
        const shim = electronApp.isPackaged
          ? [process.resourcesPath, 'conduit-mcp', 'conduit-mcp-shim.cjs'].join(separator)
          : [electronApp.getAppPath(), 'resources', 'conduit-mcp', 'conduit-mcp-shim.cjs'].join(
              separator,
            );
        return {
          command: process.execPath,
          args: [shim],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            CONDUIT_SESSION_TOKEN: `\${env:CONDUIT_SESSION_TOKEN}`,
            CONDUIT_MCP_ENDPOINT: `\${env:CONDUIT_MCP_ENDPOINT}`,
          },
        };
      });
      const raw = readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      assert(
        isDeepStrictEqual(config.mcpServers?.conduit, expected),
        `Cursor entry should match the app's command and shim: ${JSON.stringify(config.mcpServers?.conduit)}`,
      );
      assert(
        raw === `${JSON.stringify(config, null, 2)}\n`,
        'Connect writes two-space JSON plus newline',
      );
      log(`Connect wrote the exact entry and announced Connected ✓`);

      await cursor.getByRole('button', { name: 'Disconnect Cursor' }).click();
      await status.getByText('Not connected', { exact: true }).waitFor({ timeout: 10_000 });
      const disconnected = JSON.parse(readFileSync(configPath, 'utf8'));
      assert(
        !Object.hasOwn(disconnected.mcpServers ?? {}, 'conduit'),
        'Disconnect removes only the conduit entry',
      );
      assert(existsSync(configPath), 'Disconnect leaves mcp.json in place');
      log('Disconnect removed the entry, kept mcp.json, and announced Not connected ✓');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  },
  {
    userDataDir,
    env: { HOME: homeDir, USERPROFILE: homeDir },
  },
);
