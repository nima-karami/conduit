import type { TypingPort } from '../contracts/server-ports';
import {
  type ControlCallContext,
  type ControlDeps,
  type ControlHandlers,
  fail,
  isFail,
  parseKeys,
  type TargetSession,
} from './control-tools';
import type { ScreenSnapshot } from './screen-verdict';
import { isValidField, type Reach } from './tool-policy';
import type { Caller } from './tools';
import type { Presence } from './types';

export interface ScreenToolDeps {
  control: ControlDeps;
  snapshot(id: string): Promise<ScreenSnapshot | null>;
  cols(id: string): number | null;
  presence(id: string): Presence;
  bracketedPaste(id: string): boolean;
  generation(id: string): number | undefined;
  details(id: string): { label: string; home: string } | undefined;
  typing: TypingPort;
  noteInput(id: string, data: string): void;
}

type ScreenTool = 'read_screen' | 'send_input';
const KEY_BYTES = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  backspace: '\x7f',
  space: ' ',
  'ctrl+c': '\x03',
} as const;
type Key = keyof typeof KEY_BYTES;

export function createScreenToolHandlers(
  deps: ScreenToolDeps,
  prepared: ControlHandlers['prepared'],
) {
  const inReach = (
    tool: ScreenTool,
    reach: Reach | undefined,
    callerId: string,
    t: TargetSession,
  ) => {
    const r = reach !== undefined && isValidField(tool, 'reach', reach) ? reach : 'self';
    if (
      r === 'any' ||
      t.sessionId === callerId ||
      (r === 'opened' && t.openerSessionId === callerId)
    )
      return null;
    if (r === 'window') {
      const w = deps.control.ownerWindowOf(t.sessionId);
      if (w !== null && w === deps.control.ownerWindowOf(callerId)) return null;
    }
    return fail('out_of_reach', 'this session is outside the tool reach', {
      hint: `widen ${tool}'s reach in Settings → MCP to act on this session`,
    });
  };
  const target = (value: unknown, tool: ScreenTool, callerId: string, reach: Reach | undefined) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128)
      return fail('invalid_args', 'session must be a handle or id of 1–128 chars');
    const all = deps.control.targets();
    const t = all.find((x) => x.handle === value) ?? all.find((x) => x.sessionId === value);
    if (!t)
      return fail('unknown_session', `no session "${value}" in list_sessions`, {
        hint: 'use a handle from valid; list_sessions shows the current ones',
        valid: all.filter((x) => inReach(tool, reach, callerId, x) === null).map((x) => x.handle),
      });
    if (t.sessionId === callerId) return fail('self_target', 'cannot target your own session');
    return inReach(tool, reach, callerId, t) ?? t;
  };
  const recheck = (
    t: TargetSession,
    tool: ScreenTool,
    callerId: string,
    reach: Reach | undefined,
  ) => {
    const current = deps.control.targets().find((x) => x.sessionId === t.sessionId);
    return current
      ? inReach(tool, reach, callerId, current)
      : fail('unknown_session', 'that session is no longer in list_sessions', {
          hint: 'use a handle from valid; list_sessions shows the current ones',
          valid: deps.control
            .targets()
            .filter((x) => inReach(tool, reach, callerId, x) === null)
            .map((x) => x.handle),
        });
  };
  const validateText = (text: string, id: string) => {
    if (
      [...text].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
      })
    )
      return fail('invalid_args', 'text contains control characters');
    if (text.includes('\n') && !deps.bracketedPaste(id))
      return fail('invalid_args', 'newlines require bracketed paste', {
        hint: 'submit lines one at a time with submit:true',
      });
    return null;
  };
  return {
    prepareReadScreen: (caller: Caller, raw: unknown, ctx: ControlCallContext) =>
      prepared('read_screen', caller, async (who) => {
        const o = parseKeys(raw, ['session', 'lines']);
        if (isFail(o)) return o;
        const t = target(o.session, 'read_screen', who.sessionId, ctx.reach);
        if (isFail(t)) return t;
        const count = o.lines === undefined ? 60 : o.lines;
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 200)
          return fail('invalid_args', 'lines must be an integer from 1 to 200');
        return {
          summary: { tool: 'read_screen', target: t.handle },
          exec: async (token) => {
            const again = recheck(t, 'read_screen', who.sessionId, ctx.reach);
            if (again) return again;
            const snapshot = await deps.snapshot(t.sessionId);
            const lines = snapshot?.lines.map((line) => line.replace(/ +$/, '')) ?? [];
            while (lines.length && lines[lines.length - 1] === '') lines.pop();
            const start = Math.max(0, lines.length - count);
            const cursor = snapshot?.cursorY;
            const cursorRow =
              cursor !== undefined && cursor >= start && cursor < lines.length
                ? cursor - start
                : null;
            token.keep();
            return {
              ok: true,
              value: {
                session: t.handle,
                rows: lines.slice(start),
                cursor_row: cursorRow,
                cols: deps.cols(t.sessionId),
                presence: deps.presence(t.sessionId),
              },
            };
          },
        };
      }),
    prepareSendInput: (caller: Caller, raw: unknown, ctx: ControlCallContext) =>
      prepared('send_input', caller, async (who) => {
        const o = parseKeys(raw, ['session', 'text', 'keys', 'submit']);
        if (isFail(o)) return o;
        const t = target(o.session, 'send_input', who.sessionId, ctx.reach);
        if (isFail(t)) return t;
        if (o.text !== undefined && (typeof o.text !== 'string' || o.text.length > 4000))
          return fail('invalid_args', 'text must be a string of at most 4000 characters');
        if (
          o.keys !== undefined &&
          (!Array.isArray(o.keys) ||
            o.keys.length > 20 ||
            !o.keys.every((k: unknown) => typeof k === 'string' && Object.hasOwn(KEY_BYTES, k)))
        )
          return fail('invalid_args', 'keys must contain at most 20 supported keys');
        if (o.submit !== undefined && typeof o.submit !== 'boolean')
          return fail('invalid_args', 'submit must be a boolean');
        const text = (o.text ?? '') as string;
        const keys = (o.keys ?? []) as Key[];
        if (!text && keys.length === 0) return fail('invalid_args', 'give text or keys');
        const invalid = validateText(text, t.sessionId);
        if (invalid) return invalid;
        const details = deps.details(t.sessionId);
        if (!details)
          return fail('unknown_session', 'that session is no longer in list_sessions', {
            hint: 'use a handle from valid; list_sessions shows the current ones',
            valid: deps.control
              .targets()
              .filter((x) => inReach('send_input', ctx.reach, who.sessionId, x) === null)
              .map((x) => x.handle),
          });
        return {
          summary: { tool: 'send_input', target: t.handle, ...details, text, keys },
          exec: async (token) => {
            const again = recheck(t, 'send_input', who.sessionId, ctx.reach);
            if (again) return again;
            if (deps.presence(t.sessionId) === 'exited')
              return fail('session_exited', 'the target session has exited');
            const invalidNow = validateText(text, t.sessionId);
            if (invalidNow) return invalidNow;
            const generation = deps.generation(t.sessionId);
            const restarting = () => fail('session_restarting', 'the target session is restarting');
            let refusal: ReturnType<typeof fail> | null = null;
            const outcome = await deps.typing.sequence(
              t.sessionId,
              () => {
                refusal = recheck(t, 'send_input', who.sessionId, ctx.reach);
                if (refusal) return false;
                if (deps.presence(t.sessionId) === 'exited') {
                  refusal = fail('session_exited', 'the target session has exited');
                  return false;
                }
                refusal = validateText(text, t.sessionId);
                if (refusal || deps.generation(t.sessionId) !== generation) return false;
                if (text) {
                  const data = deps.bracketedPaste(t.sessionId)
                    ? `\x1b[200~${text}\x1b[201~`
                    : text;
                  if (!deps.typing.write(t.sessionId, data, { generation })) return false;
                  deps.noteInput(t.sessionId, data);
                }
                if (keys.length) {
                  const data = keys.map((key) => KEY_BYTES[key]).join('');
                  if (!deps.typing.write(t.sessionId, data, { generation })) return false;
                  deps.noteInput(t.sessionId, data);
                }
                return true;
              },
              {
                submit: o.submit === true,
                beforeEnter: () => deps.generation(t.sessionId) === generation,
              },
            );
            if (refusal) return refusal;
            if (outcome !== 'submitted') return restarting();
            if (o.submit) deps.noteInput(t.sessionId, '\r');
            token.keep();
            return {
              ok: true,
              value: { session: t.handle, sent_chars: text.length, keys_sent: keys.length },
            };
          },
        };
      }),
  };
}
