// A tiny bus so a selection in the editor can be sent to the active terminal
// without threading a callback through every layer. app.tsx installs the sink
// (it knows the active session + how to type into it); code-viewer calls send().

export interface MentionRequest {
  /** Absolute path of the file the selection is in. */
  path: string;
  /** 1-based inclusive line range of the selection. */
  startLine: number;
  endLine: number;
}

type Sink = (req: MentionRequest) => void;

let sink: Sink | null = null;

/** Install (or clear with null) the handler that delivers a mention to the terminal. */
export function setMentionSink(s: Sink | null): void {
  sink = s;
}

/** Send a selection to the active terminal, if a sink is installed. */
export function sendMention(req: MentionRequest): void {
  sink?.(req);
}
