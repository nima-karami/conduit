import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerSettingsStore } from '../../server/domain/server-settings';
import { parsePolicyFile } from '../../src/conduit-mcp/policy-file';
import { migrateLegacyPolicy } from '../../src/conduit-mcp/policy-migration';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import { DEFAULT_TOOL_POLICY } from '../../src/conduit-mcp/tool-policy';
import { tempRoots } from '../helpers/temp-roots';

const roots = tempRoots('server-settings-migration-');
afterEach(roots.cleanup);

function store(raw: unknown, name = 'server-settings.json') {
  const dir = roots.root();
  writeFileSync(join(dir, name), JSON.stringify({ version: 1, settings: { mcpToolPolicy: raw } }));
  return new ServerSettingsStore(dir, () => {});
}

describe('legacy global migration provenance', () => {
  it('records boolean conversion when the global policy is null', () => {
    const dir = roots.root();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        settings: { mcpToolPolicy: null, mcpTools: { list_sessions: false } },
      }),
    );
    const settings = new ServerSettingsStore(dir, () => {});
    expect(settings.get().mcpToolPolicy.list_sessions.access).toBe('off');
    expect(settings.explicitGlobal).toBeUndefined();
    expect(settings.resolvedGlobal).toEqual({ list_sessions: { access: 'off' } });
  });

  it.each(['server-settings.json', 'settings.json'])(
    'records effective legacy boolean differences in %s without inventing choices',
    (file) => {
      const dir = roots.root();
      writeFileSync(
        join(dir, file),
        JSON.stringify({
          version: 1,
          settings: { mcpTools: { list_sessions: false, open_terminal: true, unknown: true } },
        }),
      );
      const settings = new ServerSettingsStore(dir, () => {});
      expect(settings.explicitGlobal).toBeUndefined();
      expect(settings.resolvedGlobal).toEqual({
        list_sessions: { access: 'off' },
        open_terminal: { access: 'on', when: 'always' },
      });
      expect(settings.get().mcpToolPolicy.list_sessions.access).toBe('off');
      expect(settings.get().mcpToolPolicy.open_terminal).toMatchObject({
        access: 'on',
        when: 'always',
      });
      const result = migrateLegacyPolicy({
        global: settings.get().mcpToolPolicy,
        resolvedGlobal: settings.resolvedGlobal,
        byCli: {},
        sessions: [],
      });
      expect(result.notes.migrationSummary?.[0]).toMatchObject({
        provenance: 'resolved-global',
        fields: [
          { tool: 'list_sessions', field: 'access', value: 'off' },
          { tool: 'open_terminal', field: 'access', value: 'on' },
          { tool: 'open_terminal', field: 'when', value: 'always' },
        ],
      });
    },
  );

  it('does not report legacy booleans whose effective values remain defaults', () => {
    const dir = roots.root();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { mcpTools: { list_sessions: true, bogus: true } } }),
    );
    const settings = new ServerSettingsStore(dir, () => {});
    expect(settings.explicitGlobal).toBeUndefined();
    expect(settings.resolvedGlobal).toBeUndefined();
  });

  it.each(['server-settings.json', 'settings.json'])(
    'records only valid effective differences in a complete %s layer',
    (file) => {
      const input = structuredClone(DEFAULT_TOOL_POLICY);
      input.send_input.access = 'off';
      const raw = {
        ...input,
        open_file: { ...input.open_file, access: 'invalid', reach: 'invalid' },
        unknown: { access: 'on' },
      };
      const settings = store(raw, file);
      expect(settings.explicitGlobal).toBeUndefined();
      expect(settings.resolvedGlobal).toEqual({ send_input: { access: 'off' } });
      const result = migrateLegacyPolicy({
        global: settings.get().mcpToolPolicy,
        resolvedGlobal: settings.resolvedGlobal,
        byCli: {},
        sessions: [],
      });
      expect(result.notes.migrationSummary).toEqual([
        expect.objectContaining({
          point: { kind: 'default' },
          provenance: 'resolved-global',
          fields: [{ tool: 'send_input', field: 'access', value: 'off' }],
        }),
      ]);
      expect(result.assignments.some(({ point }) => point.kind === 'default')).toBe(true);
      const persisted = parsePolicyFile(
        JSON.stringify({
          version: 3,
          profiles: BUILT_IN_PROFILES,
          overrides: [],
          sessionDenials: [],
          ...result,
        }),
      );
      expect(persisted.ok && persisted.file.notes.migrationSummary).toEqual(
        result.notes.migrationSummary,
      );
    },
  );

  it('does not report normalized defaults as prior choices', () => {
    const settings = store(DEFAULT_TOOL_POLICY);
    expect(settings.explicitGlobal).toBeUndefined();
    expect(settings.resolvedGlobal).toBeUndefined();
    const result = migrateLegacyPolicy({
      global: settings.get().mcpToolPolicy,
      resolvedGlobal: settings.resolvedGlobal,
      byCli: {},
      sessions: [],
    });
    expect(result.notes.migrationSummary).toBeUndefined();
  });

  it('retains explicit sparse values even when equal to defaults', () => {
    const settings = store({ send_input: { access: 'ask' } });
    expect(settings.explicitGlobal).toEqual({ send_input: { access: 'ask' } });
    expect(settings.resolvedGlobal).toBeUndefined();
  });
});
