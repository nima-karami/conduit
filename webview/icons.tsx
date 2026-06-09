// Minimal inline-SVG icon set. 16px grid, currentColor stroke.
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
export const IconPin = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M9.5 2.5l4 4-2.2.6-2.4 2.4.3 2.6L8 11 5 14l3-3-1.5-1.2 2.4-2.4.6-2.4z" />
  </svg>
);
export const IconArrowUp = ({ size, className }: P) => (
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
export const IconSwap = ({ size, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3 6h8l-2-2M13 10H5l2 2" />
  </svg>
);

const glyph = (paths: React.ReactNode) => ({ size, className }: P) => (
  <svg {...base(size, className)}>{paths}</svg>
);

export const IconAgent = glyph(
  <>
    <rect x="3" y="5" width="10" height="7" rx="2" />
    <path d="M8 5V3M6 8.5h.01M10 8.5h.01" />
  </>,
);
export const IconSkill = glyph(
  <>
    <path d="M8 2.5l1.5 3.1 3.4.5-2.45 2.4.58 3.4L8 9.8 4.97 11.9l.58-3.4L3.1 6.1l3.4-.5z" />
  </>,
);
export const IconDoc = glyph(
  <>
    <path d="M4 2.5h5L12 5.5V13a.5.5 0 01-.5.5h-7A.5.5 0 014 13z" />
    <path d="M9 2.5V6h3" />
  </>,
);
export const IconHook = glyph(
  <>
    <path d="M8 3v5a2.5 2.5 0 11-2.5 2.5" />
    <path d="M6 3h4" />
  </>,
);
export const IconServer = glyph(
  <>
    <rect x="3" y="3" width="10" height="4" rx="1" />
    <rect x="3" y="9" width="10" height="4" rx="1" />
    <path d="M5.5 5h.01M5.5 11h.01" />
  </>,
);

export const IconTerminal = glyph(
  <>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M4.8 6.3l2 1.7-2 1.7M8.5 10h2.7" />
  </>,
);

export const customIcon: Record<string, (p: P) => JSX.Element> = {
  agent: IconAgent,
  skill: IconSkill,
  doc: IconDoc,
  hook: IconHook,
  server: IconServer,
};

/** Icon for a launchable shell/agent, keyed by its AgentDefinition.icon. */
export const agentIcon: Record<string, (p: P) => JSX.Element> = {
  sparkle: IconSparkle,
  terminal: IconTerminal,
};
