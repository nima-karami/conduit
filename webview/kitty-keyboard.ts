import type { IParser } from '@xterm/headless';

/** Per-screen kitty keyboard flag stack (see kitty keyboard protocol). */
export class KittyKeyboardState {
  private mainStack: number[] = [];
  private altStack: number[] = [];

  reset(): void {
    this.mainStack = [];
    this.altStack = [];
  }

  private stack(alternate: boolean): number[] {
    return alternate ? this.altStack : this.mainStack;
  }

  currentFlags(alternate: boolean): number {
    const s = this.stack(alternate);
    return s.length > 0 ? s[s.length - 1] : 0;
  }

  push(flags: number, alternate: boolean): void {
    this.stack(alternate).push(flags);
  }

  pop(count: number, alternate: boolean): void {
    const s = this.stack(alternate);
    const n = Math.max(1, count);
    for (let i = 0; i < n && s.length > 0; i++) s.pop();
  }

  set(flags: number, mode: number, alternate: boolean): void {
    const s = this.stack(alternate);
    const cur = s.length > 0 ? s[s.length - 1] : 0;
    let next = cur;
    if (mode === 1) next = flags;
    else if (mode === 2) next = cur | flags;
    else if (mode === 3) next = cur & ~flags;
    if (s.length > 0) s[s.length - 1] = next;
    else s.push(next);
  }
}

function param0(params: (number | number[])[]): number {
  const p = params[0];
  if (p === undefined) return 0;
  return typeof p === 'number' ? p : p[0];
}

function param1(params: (number | number[])[]): number {
  const p = params[1];
  if (p === undefined) return 1;
  return typeof p === 'number' ? p : p[0];
}

type ScreenReader = () => boolean;

/** Track push/pop/set from PTY output; swallow so xterm does not act on them. Do not register `CSI ? u`. */
export function registerKittyKeyboardHandlers(
  term: { parser: IParser; buffer: { active: { type: string } } },
  state: KittyKeyboardState,
  screen: ScreenReader = () => term.buffer.active.type === 'alternate',
): { dispose(): void }[] {
  return [
    term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      state.push(param0(params), screen());
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      const raw = params[0];
      const count = raw === undefined ? 1 : typeof raw === 'number' ? raw : (raw[0] ?? 1);
      state.pop(count, screen());
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      state.set(param0(params), param1(params), screen());
      return true;
    }),
    term.parser.registerEscHandler({ final: 'c' }, () => {
      state.reset();
      return false;
    }),
  ];
}

export interface KittyKeyEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  keyCode?: number;
}

function kittyModifiers(ev: KittyKeyEvent): number {
  let m = 1;
  if (ev.shiftKey) m += 1;
  if (ev.altKey) m += 2;
  if (ev.ctrlKey) m += 4;
  if (ev.metaKey) m += 8;
  return m;
}

function csiKey(keycode: number, modifiers: number): string {
  return `\x1b[${keycode};${modifiers}u`;
}

function hasModifier(ev: KittyKeyEvent): boolean {
  return ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey;
}

const FUNCTIONAL: Record<string, number> = { Enter: 13, Tab: 9, Backspace: 127, Escape: 27 };

/**
 * Encode a key for kitty disambiguate-escape mode (flag bit 1); higher bits are treated the same.
 * Ctrl/Alt chords become CSI <unshifted codepoint>;<mods>u, so Ctrl+M stays M and can never be
 * mistaken for Ctrl+Enter. Plain Enter/Tab/Backspace and Shift-only text stay legacy (spec).
 */
export function encodeKey(ev: KittyKeyEvent, flags: number): string | null {
  if (flags === 0) return null;
  const mods = kittyModifiers(ev);
  const functional = FUNCTIONAL[ev.key];
  if (functional !== undefined) {
    if (ev.key === 'Escape' && !hasModifier(ev)) return '[27u';
    return hasModifier(ev) ? csiKey(functional, mods) : null;
  }
  if (ev.key.length !== 1 || !(ev.ctrlKey || ev.altKey || ev.metaKey)) return null;
  // AltGr arrives as Ctrl+Alt on Windows: the character it produced is text, not a chord.
  if (ev.ctrlKey && ev.altKey) return null;
  return csiKey(ev.key.toLowerCase().codePointAt(0) ?? 0, mods);
}
