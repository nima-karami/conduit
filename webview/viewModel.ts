// View-model types for the dashboard shell. Decoupled from host types for now;
// the visual shell runs on mock data (wired to real state in a later milestone).

export type SessionStatus = 'active' | 'running' | 'idle' | 'done';

export interface VMSession {
  id: string;
  name: string;
  status: SessionStatus;
  branch?: string;
  added?: number;
  removed?: number;
  updatedAt: string; // human label, e.g. "11 hrs ago"
}

export interface VMProject {
  name: string;
  sessions: VMSession[];
}

export interface VMCustomization {
  id: string;
  label: string;
  icon: string;
  count?: number;
}

export type ChangeKind = 'M' | 'A' | 'D' | 'U';

export interface VMChange {
  path: string;
  added: number;
  removed: number;
  kind: ChangeKind;
}

export interface VMFileNode {
  name: string;
  kind: 'dir' | 'file';
  status?: ChangeKind;
  depth: number;
  expanded?: boolean;
}

export type Block =
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; spans: Span[] }
  | { type: 'ul'; items: Span[][] }
  | { type: 'code'; lang: string; lines: string[] };

export type Span =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'link'; v: string };

export interface VMMessage {
  role: 'user' | 'assistant';
  blocks: Block[];
}
