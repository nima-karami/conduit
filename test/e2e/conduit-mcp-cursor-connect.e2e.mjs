/**
 * Cursor's row on Settings → MCP writes only to the isolated home and removes its entry on
 * Uninstall (spec docs/specs/2026-10-26-conduit-mcp-cursor.md §3.1, as amended by
 * 2026-10-27-conduit-mcp-install; plan T5.4).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  conduitCommand,
  installRow,
  isolatedHome,
  normalizePath,
  openMcpSettings,
} from './conduit-mcp-helpers.mjs';
import { assert, profileDir, runScenario } from './harness.mjs';

const userDataDir = profileDir('cursor-connect');
const { homeDir, env } = isolatedHome(userDataDir);
const configPath = join(homeDir, '.cursor', 'mcp.json');
// ~/.cursor marks Cursor as found, as an installed Cursor would; mcp.json itself doesn't exist yet.
mkdirSync(join(homeDir, '.cursor'), { recursive: true });

await runScenario(
  'conduit-mcp-cursor-connect',
  async ({ app, page, log }) => {
    await openMcpSettings(page);
    const cursor = installRow(page, 'Cursor');
    await cursor.getByText('Not installed', { exact: true }).waitFor({ timeout: 10_000 });
    const runtimeHome = await app.evaluate(() => process.getBuiltinModule('node:os').homedir());
    assert(
      normalizePath(runtimeHome) === normalizePath(homeDir),
      `Electron homedir ${runtimeHome} should match the isolated home ${homeDir}`,
    );
    const status = await page.evaluate(async () => window.agentDeck.mcpInstall.status(null));
    const hostPath = status.clis.find((c) => c.cli === 'cursor')?.user.path ?? '';
    assert(
      normalizePath(hostPath) === normalizePath(configPath),
      `Host config path ${hostPath} should match ${configPath}`,
    );
    log('Electron and host both use the isolated Cursor home ✓');
    log('Settings starts not installed in the isolated home ✓');

    await cursor.getByRole('button', { name: 'Install Conduit for Cursor' }).click();
    await cursor.getByText('Installed', { exact: true }).waitFor({ timeout: 10_000 });
    assert(existsSync(configPath), `Install should create ${configPath}`);

    const { command, shim } = await conduitCommand(app);
    const expected = {
      command,
      args: [shim],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CONDUIT_SESSION_TOKEN: `\${env:CONDUIT_SESSION_TOKEN}`,
        CONDUIT_MCP_ENDPOINT: `\${env:CONDUIT_MCP_ENDPOINT}`,
      },
    };
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    assert(
      isDeepStrictEqual(config.mcpServers?.conduit, expected),
      `Cursor entry should match the app's command and shim: ${JSON.stringify(config.mcpServers?.conduit)}`,
    );
    assert(
      raw === `${JSON.stringify(config, null, 2)}\n`,
      'Install writes two-space JSON plus newline',
    );
    log('Install wrote the exact entry and shows Installed ✓');

    await cursor.getByRole('button', { name: 'Uninstall Conduit from Cursor' }).click();
    await cursor.getByText('Not installed', { exact: true }).waitFor({ timeout: 10_000 });
    const uninstalled = JSON.parse(readFileSync(configPath, 'utf8'));
    assert(
      !Object.hasOwn(uninstalled.mcpServers ?? {}, 'conduit'),
      'Uninstall removes only the conduit entry',
    );
    assert(existsSync(configPath), 'Uninstall leaves mcp.json in place');
    log('Uninstall removed the entry, kept mcp.json, and shows Not installed ✓');
  },
  { userDataDir, env },
);
