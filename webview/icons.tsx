// Minimal inline-SVG icon set. 16px grid, currentColor stroke.
import type { SessionIconKind } from '../src/session-icon';

type P = { size?: number; className?: string };
const base = (size = 16, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
});

export const IconSearch = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);
export const IconPlus = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);
export const IconChevron = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);
export const IconFolder = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M2 4.5A1.5 1.5 0 013.5 3h2.7l1.3 1.6h5A1.5 1.5 0 0114 6.1V11A1.5 1.5 0 0112.5 12.5h-9A1.5 1.5 0 012 11z" />
  </svg>
);
export const IconGraph = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="2" y="2.5" width="4.5" height="3.5" rx="1" />
    <rect x="9.5" y="10" width="4.5" height="3.5" rx="1" />
    <rect x="9.5" y="2.5" width="4.5" height="3.5" rx="1" />
    <path d="M6.5 4.25h3M6.5 4.25a4 4 0 014 4v3.5" />
  </svg>
);
export const IconBranch = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="4" cy="4" r="1.6" />
    <circle cx="4" cy="12" r="1.6" />
    <circle cx="12" cy="5.5" r="1.6" />
    <path d="M4 5.6v4.8M4 8h4a4 4 0 004-4" />
  </svg>
);
export const IconSparkle = ({ size, className }: P) => (
  <svg {...base(size, className)} strokeWidth={1.2}>
    <path d="M8 2.2l1.4 3.6L13 7.2 9.4 8.6 8 12.2 6.6 8.6 3 7.2l3.6-1.4z" />
  </svg>
);
export const IconClose = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
const _IconPin = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M9.5 2.5l4 4-2.2.6-2.4 2.4.3 2.6L8 11 5 14l3-3-1.5-1.2 2.4-2.4.6-2.4z" />
  </svg>
);
const _IconArrowUp = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M8 13V4M4.5 7.5L8 4l3.5 3.5" />
  </svg>
);
export const IconSidebar = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6.5 3v10" />
  </svg>
);
const _IconSwap = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3 6h8l-2-2M13 10H5l2 2" />
  </svg>
);

export const IconMore = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);
export const IconCheck = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);
export const IconSettings = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.7M8 12.7v1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M1.6 8h1.7M12.7 8h1.7M3.5 12.5l1.2-1.2M11.3 4.7l1.2-1.2" />
  </svg>
);
export const IconCommand = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M5.5 3.5A1.5 1.5 0 105.5 6.5h5a1.5 1.5 0 100-3 1.5 1.5 0 00-1.5 1.5v5a1.5 1.5 0 11-1.5-1.5h-1" />
  </svg>
);
export const IconExternal = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M9 3.5h3.5V7M12 4l-5 5M11 9v3.5H3.5V5H7" />
  </svg>
);
export const IconCopy = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="5.5" y="5.5" width="7" height="7" rx="1.2" />
    <path d="M3.5 10.5V4A1.5 1.5 0 015 2.5h5.5" />
  </svg>
);
export const IconDuplicate = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="5.5" y="5.5" width="7" height="7" rx="1.2" />
    <path d="M3.5 10.5V4A1.5 1.5 0 015 2.5h5.5M9 7v3M7.5 8.5h3" />
  </svg>
);
export const IconTrash = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3 4.5h10M6.5 4.5V3.2A.7.7 0 017.2 2.5h1.6a.7.7 0 01.7.7v1.3M4.5 4.5l.6 8a.8.8 0 00.8.7h4.2a.8.8 0 00.8-.7l.6-8" />
  </svg>
);
export const IconBoard = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M6 3v10M10 3v10" />
  </svg>
);
export const IconPencil = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M10.5 2.8l2.7 2.7L6 12.7l-3 .6.6-3z" />
  </svg>
);

const glyph =
  (paths: React.ReactNode) =>
  ({ size, className }: P) => <svg {...base(size, className)}>{paths}</svg>;

const IconAgent = glyph(
  <>
    <rect x="3" y="5" width="10" height="7" rx="2" />
    <path d="M8 5V3M6 8.5h.01M10 8.5h.01" />
  </>,
);
const IconSkill = glyph(
  <path d="M8 2.5l1.5 3.1 3.4.5-2.45 2.4.58 3.4L8 9.8 4.97 11.9l.58-3.4L3.1 6.1l3.4-.5z" />,
);
export const IconDoc = glyph(
  <>
    <path d="M4 2.5h5L12 5.5V13a.5.5 0 01-.5.5h-7A.5.5 0 014 13z" />
    <path d="M9 2.5V6h3" />
  </>,
);
const IconHook = glyph(
  <>
    <path d="M8 3v5a2.5 2.5 0 11-2.5 2.5" />
    <path d="M6 3h4" />
  </>,
);
const IconServer = glyph(
  <>
    <rect x="3" y="3" width="10" height="4" rx="1" />
    <rect x="3" y="9" width="10" height="4" rx="1" />
    <path d="M5.5 5h.01M5.5 11h.01" />
  </>,
);

export const IconWinMin = glyph(<path d="M3 8h10" />);
export const IconWinMax = glyph(<rect x="3.5" y="3.5" width="9" height="9" rx="1" />);
export const IconWinRestore = glyph(
  <>
    <rect x="5" y="3" width="8" height="8" rx="1" />
    <path d="M3 6v7h7" />
  </>,
);

export const IconTerminal = glyph(
  <>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M4.8 6.3l2 1.7-2 1.7M8.5 10h2.7" />
  </>,
);

// PowerShell-flavoured terminal: a chevron prompt + a caret line, evoking the
// classic ">" prompt without claiming the official logo.
const IconPowerShell = glyph(
  <>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M5 6l2.4 2-2.4 2M8.6 10.2h2.6" />
  </>,
);

// A tasteful AI/sparkle mark for Claude-like agents. NOT an official logo — a
// generic "intelligent agent" glyph (a large four-point sparkle with a small
// companion spark), consistent with the 16px / currentColor icon set.
const IconClaude = ({ size, className }: P) => (
  <svg {...base(size, className)} strokeWidth={1.25}>
    <path d="M7 2.2l1.1 2.9L11 6.2 8.1 7.3 7 10.2 5.9 7.3 3 6.2l2.9-1.1z" />
    <path d="M11.6 9.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" />
  </svg>
);

const _customIcon: Record<string, (p: P) => JSX.Element> = {
  agent: IconAgent,
  skill: IconSkill,
  doc: IconDoc,
  hook: IconHook,
  server: IconServer,
};

/** Icon for a launchable shell/agent, keyed by its AgentDefinition.icon. */
const _agentIcon: Record<string, (p: P) => JSX.Element> = {
  sparkle: IconSparkle,
  terminal: IconTerminal,
};

const SESSION_ICON: Record<SessionIconKind, (p: P) => JSX.Element> = {
  claude: IconClaude,
  powershell: IconPowerShell,
  terminal: IconTerminal,
};

/**
 * Glyph for a session tab, derived from what the session runs (D4). Decorative —
 * the agent label/name carries the meaning for assistive tech, so this is
 * aria-hidden. See {@link iconForSession} for the (pure, tested) kind mapping.
 */
export function SessionGlyph({ kind, size, className }: P & { kind: SessionIconKind }) {
  const Icon = SESSION_ICON[kind];
  return (
    <span className="session__icon" aria-hidden>
      <Icon size={size} className={className} />
    </span>
  );
}
