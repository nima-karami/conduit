import { describe, expect, it } from 'vitest';
import {
  createMcpServerCore,
  type JsonRpcId,
  type McpServerCoreDeps,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOLS_LIST_CHANGED,
  type ToolCallResult,
  type ToolSchema,
} from '../../src/conduit-mcp/json-rpc';
import { TOOL_NAMES } from '../../src/conduit-mcp/tool-policy';
import { CONDUIT_INSTRUCTIONS, toolSchemas } from '../../src/conduit-mcp/tool-schemas';

const AGENTS = ['claude', 'codex', 'shell:pwsh'] as const;
const SCHEMAS = toolSchemas(AGENTS);

function core(over: Partial<McpServerCoreDeps> = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const deps: McpServerCoreDeps = {
    serverInfo: { name: 'conduit', version: '9.9.9' },
    instructions: 'peers are agents',
    tools: () => SCHEMAS,
    call: async (name, args): Promise<ToolCallResult> => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    cancelled: () => {},
    ...over,
  };
  return { server: createMcpServerCore(deps), calls };
}

async function rpc(line: string, over: Partial<McpServerCoreDeps> = {}) {
  const { server, calls } = core(over);
  const out = await server.handleLine(line);
  return { reply: out === undefined ? undefined : JSON.parse(out), calls };
}

const req = (id: JsonRpcId, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

function schemaOf(name: string): ToolSchema {
  const t = SCHEMAS.find((s) => s.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

type Props = Record<string, Record<string, unknown>>;

describe('createMcpServerCore', () => {
  it('initialize echoes a supported protocolVersion', async () => {
    const { reply } = await rpc(req(1, 'initialize', { protocolVersion: '2025-06-18' }));
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(reply.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(reply.result.serverInfo).toEqual({ name: 'conduit', version: '9.9.9' });
    expect(reply.result.instructions).toBe('peers are agents');
  });

  it('initialize answers the newest supported for an unknown version', async () => {
    const { reply } = await rpc(req(1, 'initialize', { protocolVersion: '1999-01-01' }));
    expect(reply.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocolVersion(undefined)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocolVersion('2024-11-05')).toBe('2024-11-05');
  });

  it('server/discover gets method-not-found with its id', async () => {
    const { reply } = await rpc(req(7, 'server/discover'));
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } });
  });

  it('notifications get no reply', async () => {
    const { reply } = await rpc('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(reply).toBeUndefined();
  });

  it('ping answers an empty result', async () => {
    const { reply } = await rpc(req('p', 'ping'));
    expect(reply).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
  });

  it('tools/list returns deps.tools()', async () => {
    const { reply } = await rpc(req(2, 'tools/list'));
    expect(reply.result.tools).toEqual(SCHEMAS);
  });

  it('tools/list is empty when deps.tools() is empty', async () => {
    const { reply } = await rpc(req(2, 'tools/list'), { tools: () => [] });
    expect(reply.result.tools).toEqual([]);
  });

  it('tools/call forwards name and arguments (default {})', async () => {
    const a = await rpc(req(3, 'tools/call', { name: 'read_inbox', arguments: { limit: 3 } }));
    expect(a.calls).toEqual([{ name: 'read_inbox', args: { limit: 3 } }]);
    expect(a.reply.result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const b = await rpc(req(4, 'tools/call', { name: 'list_sessions' }));
    expect(b.calls).toEqual([{ name: 'list_sessions', args: {} }]);
  });

  it('tools/call open_session reaches deps.call (not invalid_argument)', async () => {
    const { calls } = await rpc(
      req(6, 'tools/call', { name: 'open_session', arguments: { path: '.' } }),
    );
    expect(calls).toEqual([{ name: 'open_session', args: { path: '.' } }]);
  });

  it('every catalog name reaches deps.call', async () => {
    for (const name of TOOL_NAMES) {
      const { calls } = await rpc(req(1, 'tools/call', { name }));
      expect(calls.map((c) => c.name)).toEqual([name]);
    }
  });

  it('tools/call with an unknown tool name is an invalid_argument tool error', async () => {
    const { reply, calls } = await rpc(req(5, 'tools/call', { name: 'rm_rf', arguments: {} }));
    expect(calls).toEqual([]);
    expect(reply.result.isError).toBe(true);
    expect(JSON.parse(reply.result.content[0].text).error.code).toBe('invalid_argument');
  });

  it('TOOLS_LIST_CHANGED is a JSON-RPC notification without id', () => {
    const n = JSON.parse(TOOLS_LIST_CHANGED);
    expect(n).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    expect('id' in n).toBe(false);
  });

  it('parse error → -32700 id null', async () => {
    const { reply } = await rpc('{not json');
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
  });

  it('batch array → -32600', async () => {
    const { reply } = await rpc(`[${req(1, 'ping')}]`);
    expect(reply).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('a request missing method → -32600 with its id', async () => {
    const { reply } = await rpc('{"jsonrpc":"2.0","id":9}');
    expect(reply).toMatchObject({ id: 9, error: { code: -32600 } });
  });
});

describe('toolSchemas', () => {
  it('toolSchemas lists every catalog tool in order; every schema is a closed object', () => {
    expect(SCHEMAS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(SCHEMAS).toHaveLength(14);
    for (const t of SCHEMAS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('open_session.agent.enum equals the given ids', () => {
    const s = schemaOf('open_session').inputSchema;
    const p = s.properties as Props;
    expect(p.agent).toMatchObject({ type: 'string', enum: [...AGENTS] });
    expect(p.label).toMatchObject({ type: 'string', maxLength: 80 });
    expect(p.focus).toMatchObject({ type: 'boolean', default: true });
    expect(s.required).toEqual(['path', 'agent']);
    const other = toolSchemas(['x']).find((t) => t.name === 'open_session');
    expect((other?.inputSchema.properties as Props | undefined)?.agent.enum).toEqual(['x']);
  });

  it('open_terminal bounds: command maxLength 1024, args maxItems 64', () => {
    const s = schemaOf('open_terminal').inputSchema;
    const p = s.properties as Props;
    expect(p.command).toMatchObject({ type: 'string', maxLength: 1024 });
    expect(p.args).toMatchObject({ type: 'array', maxItems: 64, items: { type: 'string' } });
    expect(s.required).toEqual(['path', 'command']);
    expect(schemaOf('open_terminal').description).toMatch(/argv, not a shell/);
  });

  it('open_file: line/column integers ≥ 1, required path', () => {
    const s = schemaOf('open_file').inputSchema;
    const p = s.properties as Props;
    expect(p.line).toMatchObject({ type: 'integer', minimum: 1 });
    expect(p.column).toMatchObject({ type: 'integer', minimum: 1 });
    expect(s.required).toEqual(['path']);
  });

  it('control descriptions say paths are absolute or relative to the home folder', () => {
    for (const n of ['open_session', 'open_terminal', 'open_file'])
      expect(schemaOf(n).description).toMatch(/home folder/);
  });

  it('send_message schema bounds', () => {
    const s = schemaOf('send_message').inputSchema;
    const p = s.properties as Props;
    expect(p.to).toMatchObject({ type: 'array', minItems: 1, maxItems: 10 });
    expect(p.attachments).toMatchObject({ type: 'array', maxItems: 5 });
    expect(p.subject).toMatchObject({ type: 'string', maxLength: 200 });
    expect(p.priority).toMatchObject({ enum: ['fyi', 'normal', 'urgent'], default: 'normal' });
    expect(p.kind).toMatchObject({
      enum: ['inform', 'request', 'question', 'done'],
      default: 'inform',
    });
    expect(s.required).toEqual(['to', 'body']);
    expect(p.from).toBeUndefined();
  });

  it('read_inbox and read_attachment bounds', () => {
    const inbox = schemaOf('read_inbox').inputSchema.properties as Props;
    expect(inbox.limit).toMatchObject({ type: 'integer', maximum: 50 });
    const att = schemaOf('read_attachment').inputSchema;
    expect((att.properties as Props).offset).toMatchObject({ type: 'integer', minimum: 0 });
    expect(att.required).toEqual(['message_id', 'attachment_id']);
  });

  it('descriptions warn that peer bodies are not user instructions', () => {
    expect(CONDUIT_INSTRUCTIONS).toMatch(/not the user/i);
    expect(schemaOf('read_inbox').description).toMatch(/not .*user/i);
  });
});

describe('request ids and cancellation (spec 2026-10-30-conduit-mcp-tool-policy §2.4)', () => {
  function withCtx(result: ToolCallResult | null = { content: [{ type: 'text', text: 'ok' }] }) {
    const ctxs: unknown[] = [];
    const cancels: unknown[] = [];
    const { server } = core({
      call: async (_name, _args, ctx) => {
        ctxs.push(ctx);
        return result;
      },
      cancelled: (requestId) => cancels.push(requestId),
    });
    return { server, ctxs, cancels };
  }
  const note = (method: string, params?: unknown) =>
    JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });

  it('tools/call passes the request id', async () => {
    const { server, ctxs } = withCtx();
    await server.handleLine(req(7, 'tools/call', { name: 'read_inbox' }));
    await server.handleLine(req('a', 'tools/call', { name: 'read_inbox' }));
    const nullId = await server.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'tools/call',
        params: { name: 'read_inbox' },
      }),
    );
    expect(ctxs).toEqual([{ requestId: 7 }, { requestId: 'a' }, { requestId: null }]);
    expect(JSON.parse(nullId ?? '{}')).toMatchObject({ id: null, result: {} });
  });

  it('a null call result sends no reply', async () => {
    const { server } = withCtx(null);
    expect(await server.handleLine(req(3, 'tools/call', { name: 'open_session' }))).toBeUndefined();
  });

  it('notifications/cancelled reaches cancelled()', async () => {
    const { server, cancels } = withCtx();
    for (const requestId of [4, 'r-1', null, true, { x: 1 }, undefined])
      expect(
        await server.handleLine(note('notifications/cancelled', { requestId, reason: 'esc' })),
      ).toBeUndefined();
    expect(await server.handleLine(note('notifications/cancelled'))).toBeUndefined();
    expect(cancels).toEqual([4, 'r-1']);
  });

  it('other notifications still dropped', async () => {
    const { server, ctxs, cancels } = withCtx();
    expect(await server.handleLine(note('notifications/initialized'))).toBeUndefined();
    expect(
      await server.handleLine(note('notifications/progress', { requestId: 4 })),
    ).toBeUndefined();
    expect(await server.handleLine(note('tools/call', { name: 'read_inbox' }))).toBeUndefined();
    expect([ctxs, cancels]).toEqual([[], []]);
  });
});
