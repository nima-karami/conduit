// Server B for the Tier 2 run, inside the VM (tools/vm-peer.mjs). The host driver (net-vm.mjs)
// talks to it over the ssh session's stdio, so no control port is opened: one JSON request per
// stdin line, one `@@`-prefixed JSON reply per stdout line. Helper logs pass through unprefixed.
import { createInterface } from 'node:readline';
import { callTool, startAgent, startServer } from '../net-helpers.mjs';

const reply = (msg) => process.stdout.write(`@@${JSON.stringify(msg)}\n`);
const server = await startServer('vm-b');
// `auto`, as a person would leave it: the guest's loopback and its private NIC address. QEMU's
// 127.0.0.1-only forward on the host is still the only way in.
await server.c2.call('serverSettings.patch', {
  patch: { networkBindHost: 'auto', networkPort: 47391, networkSelfName: 'vm-b' },
});
const agents = new Map();
reply({ ready: true });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, op, method, params, sessionId, tool, args } = JSON.parse(line);
  try {
    let result;
    if (op === 'call') result = await server.c2.call(method, params ?? {});
    else if (op === 'agent') {
      const agent = await startAgent(server);
      agents.set(agent.sessionId, agent);
      result = agent;
    } else if (op === 'tool') result = await callTool(server, agents.get(sessionId), tool, args);
    else if (op === 'stop') {
      await server.stop();
      reply({ id, result: 'stopped' });
      process.exit(0);
    } else throw new Error(`unknown op ${op}`);
    reply({ id, result });
  } catch (error) {
    reply({ id, error: String(error?.message ?? error) });
  }
}
await server.stop();
