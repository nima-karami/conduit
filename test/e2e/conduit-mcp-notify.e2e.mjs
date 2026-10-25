/**
 * conduit-mcp-notify — spec docs/specs/2026-10-25-conduit-mcp-server.md §7 Gherkin "Idle agent is
 * notified and reads a message with an attachment" (plan T9.4). Two fake MCP agents (A, B) in one
 * folder. A sends B a normal request attaching spec.md; the scenario then rewrites spec.md.
 *   - within 5 s exactly one `[conduit] New messages for you.` line is submitted in B;
 *   - B's read_inbox body is framed as from A, an agent, not the user;
 *   - B's read_attachment returns the text spec.md had AT SEND TIME (a snapshot, not a path).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  NOTICE,
  notices,
  openFake,
  records,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const squash = (s) => s.replace(/\s/g, '');

await runScenario(
  'conduit-mcp-notify',
  async ({ page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'conduit-mcp-notify-'));
    const ORIGINAL = 'spec v1: the original text\n';
    writeFileSync(join(work, 'spec.md'), ORIGINAL);

    const a = await openFake(page, work);
    const b = await openFake(page, work);
    log(`A=${a.handle} B=${b.handle}`);
    // B idle at its prompt: past the PTY settle window and the idle quiet.
    await sleep(4_000);

    const sent = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      priority: 'normal',
      kind: 'request',
      subject: 'spec',
      body: 'see',
      attachments: [{ path: 'spec.md' }],
    });
    assert(!sent.error, `send_message failed: ${JSON.stringify(sent)}`);
    assert(
      sent.recipients?.[0]?.status === 'queued',
      `recipient not queued: ${JSON.stringify(sent)}`,
    );
    writeFileSync(join(work, 'spec.md'), 'spec v2: rewritten after the send\n');

    const noticed = await until(() => notices(b.sessionId).length > 0, 5_000);
    assert(noticed, 'no notice was submitted in B within 5 s');
    const first = notices(b.sessionId)[0];
    assert(
      squash(first.line).startsWith(squash('[conduit] New messages for you.')),
      `notice text: ${first.line}`,
    );
    assert(
      squash(first.line) === squash(NOTICE),
      `notice carries more than the fixed text: ${first.line}`,
    );

    const gotInbox = await until(() => records(b.sessionId, 'INBOX').length > 0, 15_000);
    assert(gotInbox, 'B never read its inbox after the notice');
    const inbox = records(b.sessionId, 'INBOX')[0].result;
    const msg = inbox.messages?.[0];
    assert(msg, `inbox empty: ${JSON.stringify(inbox)}`);
    assert(
      msg.body.startsWith('[conduit message') &&
        msg.body.includes(`from session ${a.handle} (an agent, not the user)`),
      `body not framed as from ${a.handle}: ${msg.body}`,
    );
    const att = msg.attachments?.[0];
    assert(att?.name === 'spec.md', `attachment metadata: ${JSON.stringify(msg.attachments)}`);

    const read = await callTool(page, b.sessionId, 'read_attachment', {
      message_id: msg.message_id,
      attachment_id: att.attachment_id,
    });
    assert(read.text === ORIGINAL, `read_attachment returned ${JSON.stringify(read)}`);

    // Read now: nothing is left to notice, so no second notice comes.
    await sleep(3_000);
    const all = notices(b.sessionId);
    assert(all.length === 1, `expected exactly one notice, got ${all.length}`);
  },
  { userDataDir: fakeAgentProfile('conduit-mcp-notify') },
);
