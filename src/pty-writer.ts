export type SubmitOutcome =
  | 'submitted'
  | 'no-pty'
  | 'write-failed'
  | 'generation-changed'
  | 'gate-closed'
  | 'withheld';
