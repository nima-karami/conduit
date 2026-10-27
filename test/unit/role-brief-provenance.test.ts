import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolSchemas } from '../../src/conduit-mcp/tool-schemas';

// AC11: the MCP surface never carries a role brief (docs/specs/2026-10-26-conduit-role-brief.md §3.4).
const root = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return walk(rel);
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
}

describe('role brief provenance', () => {
  it('MCP modules other than adapters.ts do not mention the role brief', () => {
    const files = [
      'electron/conduit-mcp-host.ts',
      'electron/conduit-mcp-endpoint.ts',
      ...walk('src/conduit-mcp').filter((f) => !f.endsWith('/adapters.ts')),
    ];
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) expect(read(f), f).not.toMatch(/role-brief/);
  });

  it('no MCP tool schema has a brief property', () => {
    expect(JSON.stringify(toolSchemas(['claude']))).not.toContain('"brief"');
  });

  it('only the host and the session manager write a brief state, and no MCP file reads one', () => {
    const all = [...walk('src'), ...walk('electron'), ...walk('webview')];
    const writers = all.filter((f) => read(f).includes('setBrief(')).sort();
    expect(writers).toEqual(['electron/role-brief-host.ts', 'src/session-manager.ts']);
    const mcp = all.filter(
      (f) => f.startsWith('src/conduit-mcp/') || f.startsWith('electron/conduit-mcp-'),
    );
    expect(mcp.length).toBeGreaterThan(2);
    for (const f of mcp) expect(read(f), f).not.toMatch(/\.brief\b/);
  });

  it('electron/main.ts is the only importer of role-brief-host', () => {
    const importers = [...walk('src'), ...walk('electron'), ...walk('webview')].filter(
      (f) => /role-brief-host/.test(read(f)) && f !== 'electron/role-brief-host.ts',
    );
    expect(importers.filter((f) => f !== 'electron/main.ts')).toEqual([]);
  });
});
