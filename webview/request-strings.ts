// User-facing strings for the Needs you panel, the request pop-up and tab, and the signals.
// Words follow the owner's rule (UX.md §8): Space, Session, Request; the list is "Needs you".

import { countNoun } from '../src/menu-selection';

const mmss = (totalSeconds: number): string => {
  const m = Math.floor(totalSeconds / 60);
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s}`;
};

export const REQ_STR = {
  typeWord: { approve: 'Approve', answer: 'Answer', review: 'Review' },
  conduit: 'Conduit',
  waiting: (secondsLeft: number) => `${mmss(secondsLeft)} waiting`,
  urgent: 'Urgent',
  expires: (timeLabel: string) => `Expires in ${timeLabel}`,
  tabLines: (n: number) => countNoun(n, 'line', 'lines'),
  inTerminal: 'in terminal',

  panelTitle: 'Needs you',
  open: (n: number) => `Open · ${n}`,
  history: 'History',
  sort: { soonest: 'Soonest needed', newest: 'Newest', oldest: 'Oldest', session: 'By session' },
  filterSection: {
    session: 'Session',
    leads: 'Lead group',
    space: 'Space',
    type: 'Type',
    machine: 'Machine',
  },
  show: { space: 'Space', age: 'Age', machine: 'Machine' },
  legend: 'What the icons mean',
  filtered: (shown: number, total: number) => `Filtered · ${shown} of ${total} shown`,
  clear: 'Clear',
  empty: 'Nothing needs you',
  caughtUp: 'All caught up',
  filteredEmpty: 'No requests match these filters',

  asksYouToChoose: (handle: string) => `${handle} asks you to choose`,
  asksYouToApprove: (handle: string) => `${handle} asks you to approve`,
  asksYouToReview: (handle: string) => `${handle} asks you to review`,
  asksYouToAnswer: (handle: string) => `${handle} asks you to answer`,
  waitingAtPrompt: (handle: string) => `${handle} is waiting at a prompt`,

  yes: 'Yes',
  no: 'No',
  approveWithEdits: 'Approve with my edits',
  approveAsWritten: 'Approve as written',
  reject: 'Reject',
  ownWordsLabel: 'Or answer in your own words',
  ownWordsPlaceholder: 'Add a note, or answer something else',
  noteLabel: 'Note (optional)',
  send: 'Send',

  openAsTab: 'Open as tab',
  openTerminal: 'Open terminal',
  skip: 'Skip',
  next: (n: number) => `Next: ${n} more`,

  answered: 'Answered',
  expired: 'Expired',
  withdrawnBy: (handle: string) => `Withdrawn by ${handle}`,
  withdrawnByConduit: 'Withdrawn by Conduit',
  replaced: 'Replaced by a newer request',
  clearedByItself: 'Cleared by itself',
  notDelivered: 'Not delivered: the session was closed',
  wentWithDefault: "Went with the agent's default",

  receipt: (handle: string) => `Sent to ${handle}`,

  pill: (n: number) => `Waiting on you · ${countNoun(n, 'request', 'requests')}`,
  pillOne: 'Waiting on you',
  notice: (handle: string, kind: 'approve' | 'answer') =>
    `${handle} is waiting for your ${kind === 'approve' ? 'approval' : 'answer'}`,

  pillStr: {
    count: (n: number) => countNoun(n, 'request', 'requests'),
    waiting: (secondsLeft: number, n: number) =>
      `◉ Waiting on you · ${mmss(secondsLeft)}${n > 1 ? ` · ${countNoun(n, 'request', 'requests')}` : ''}`,
    menu: 'Requests from this session',
  },

  forOneHour: 'For 1 hour',
  untilTomorrow: (time: string) => `Until ${time} tomorrow`,
  untilBack: "Until I'm back",
  back: "I'm back",
  awayUntil: (time: string) => `Away until ${time}`,
  awayEnded: (time: string) => `Away ended ${time}`,

  digestTitle: 'While you were away',
  stillNeedYou: (n: number) => `${countNoun(n, 'request', 'requests')} still need you`,
  wentWithDefaultN: (n: number) => `${countNoun(n, 'request', 'requests')} went with the default`,
  expiredN: (n: number) => `${countNoun(n, 'request', 'requests')} expired`,
  clearedN: (n: number) => `${countNoun(n, 'request', 'requests')} cleared by themselves`,
  showItems: 'show',
  followUp: 'Follow up…',
  dismiss: 'Dismiss',
  cantUndo: "A follow-up sends a message. It can't undo an answer that already went.",
  needsMenu: {
    trigger: 'Sort, filter and show',
    sortHeading: 'Sort',
    filterHeading: 'Filter',
    showHeading: 'Show on cards',
    defaultSort: 'default',
    all: 'All',
  },
  needsPane: {
    emptyPurpose: "Agents' questions and approvals appear here.",
    historyEmpty: 'Answered and closed requests appear here for 30 days.',
    legendAsked: "What you're asked to do",
    legendApprove: "Say yes or no: a tool permission, or an agent's yes/no.",
    legendAnswer: 'Pick an option or write a reply.',
    legendReview: 'Edit or approve a draft, or fill in a form.',
    legendOpens: 'Where it opens',
    markerPopup: 'A pop-up over the editor.',
    markerTab: 'A tab beside the agent: too long for a pop-up.',
    markerTerminal: "The agent's own prompt, in its terminal.",
    legendAlso: 'Also',
    conduitMeaning: 'Conduit wrote it, not an agent. Agents can never show this.',
    waitingMeaning: 'An agent is blocked until you answer.',
    closeLegend: 'Got it',
    newRequests: (n: number) => countNoun(n, 'new request', 'new requests'),
    filtered: (names: string, shown: number, total: number) =>
      `Filtered: ${names} · ${shown} of ${total} shown`,
  },
  reqTab: {
    title: 'Request',
    gone: 'This request no longer exists',
    goneHint: 'It was answered or closed. Find it under History in Needs you.',
  },
  reqTpl: {
    close: 'Close',
    answerLabel: 'Your answer',
    draftViews: 'Draft view',
    editedTab: 'Edited',
    originalTab: 'Original',
    changesTab: 'Changes',
    editedLabel: 'Edited draft',
    linesChanged: (n: number) => `${countNoun(n, 'line', 'lines')} changed`,
    changedLines: (list: string) => `Lines ${list}`,
    noChanges: 'No lines changed',
    draftTooLong: (maxBytes: number) =>
      `Too long to send: the edited draft is over ${maxBytes} bytes.`,
    needPick: 'Pick an option to send.',
    attendLine: "Answer in its terminal, where it's waiting.",
  },
  threadLink: {
    open: (title: string) => `Open request: ${title}`,
  },
};
