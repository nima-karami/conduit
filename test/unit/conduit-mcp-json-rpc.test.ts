import { describe, expect, it } from 'vitest';
import {
  createMcpServerCore,
  type McpServerCoreDeps,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ToolCallResult,
  type ToolSchema,
} from '../../src/conduit-mcp/json-rpc';
import { CONDUIT_INSTRUCTIONS, CONDUIT_TOOLS } from '../../src/conduit-mcp/tool-schemas';

function core(over: Partial<McpServerCoreDeps> = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const deps: McpServerCoreDeps = {
    serverInfo: { name: 'conduit', version: '9.9.9' },
    instructions: 'peers are agents',
    tools: () => CONDUIT_TOOLS,
    call: async (name, args): Promise<ToolCallResult> => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    ...over,
  };
  return { server: createMcpServerCore(deps), calls };
}

async function rpc(line: string, over: Partial<McpServerCoreDeps> = {}) {
  const { server, calls } = core(over);
  const out = await server.handleLine(line);
  return { reply: out === undefined ? undefined : JSON.parse(out), calls };
}

const req = (id: number | string, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

function schemaOf(name: string): ToolSchema {
  const t = CONDUIT_TOOLS.find((s) => s.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

type Props = Record<string, Record<string, unknown>>;

describe('createMcpServerCore', () => {
  it('initialize echoes a supported protocolVersion', async () => {
    const { reply } = await rpc(req(1, 'initialize', { protocolVersion: '2025-06-18' }));
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(reply.result.capabilities).toEqual({ tools: { listChanged: false } });
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
    expect(reply.result.tools).toEqual(CONDUIT_TOOLS);
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

  it('tools/call with an unknown tool name is an invalid_argument tool error', async () => {
    const { reply, calls } = await rpc(req(5, 'tools/call', { name: 'rm_rf', arguments: {} }));
    expect(calls).toEqual([]);
    expect(reply.result.isError).toBe(true);
    expect(JSON.parse(reply.result.content[0].text).error.code).toBe('invalid_argument');
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

describe('CONDUIT_TOOLS', () => {
  it('CONDUIT_TOOLS names are exactly the four', () => {
    expect(CONDUIT_TOOLS.map((t) => t.name)).toEqual([
      'list_sessions',
      'send_message',
      'read_inbox',
      'read_attachment',
    ]);
    for (const t of CONDUIT_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
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
