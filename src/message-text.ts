// Scheduled-message text: line breaks kept, a hard cap that rejects instead of truncating.
// see docs/specs/2026-11-13-scheduler-auto-resume.md §3 "Delivery"

export const MAX_MESSAGE_CHARS = 16_000;
export const MESSAGE_TOO_LONG = 'Too long — 16,000 characters at most';
const MESSAGE_EMPTY = 'Message is empty';

export type MessageCheck = { ok: true; message: string } | { ok: false; error: string };

/**
 * Only `\n` survives among control characters: ESC would let a message inject a sequence (or end a
 * bracketed paste early), and a bare CR would submit mid-message. A tab becomes a space so words
 * it separated stay apart.
 */
export function normalizeMessage(raw: string): MessageCheck {
  let out = '';
  for (const ch of raw.replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0a) out += ch;
    else if (c === 0x09) out += ' ';
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue;
    else out += ch;
  }
  const message = out.trim();
  if (message === '') return { ok: false, error: MESSAGE_EMPTY };
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: MESSAGE_TOO_LONG };
  return { ok: true, message };
}

/** Without bracketed paste a newline is Enter, so the message would submit at its first line break. */
export function deliverableText(
  message: string,
  bracketed: boolean,
): { text: string; joined: boolean } {
  if (bracketed || !message.includes('\n')) return { text: message, joined: false };
  const text = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
  return { text, joined: true };
}
