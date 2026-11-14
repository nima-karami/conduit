import type { JSX, ReactNode } from 'react';

// Matches RequestType in request-view-model.ts; unified when both land (CON-20 U1).
export type RequestType = 'approve' | 'answer' | 'review';

const SHAPES: Record<RequestType, ReactNode> = {
  approve: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="2.5" />
      <path d="M6.6 10.2l2.2 2.2 4.6-4.8" />
    </>
  ),
  answer: (
    <>
      <path d="M4 4h12a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0116 14H9.2L6 16.2V14H4a1.5 1.5 0 01-1.5-1.5v-7A1.5 1.5 0 014 4z" />
      <path d="M8 8a2 2 0 113 1.7c-.6.3-1 .7-1 1.4" />
      <path d="M10 13.4v.01" />
    </>
  ),
  review: (
    <>
      <path d="M5 2.5h6l3.5 3.5v10.5a1 1 0 01-1 1H5a1 1 0 01-1-1V3.5a1 1 0 011-1z" />
      <path d="M11 2.5V6h3.5" />
      <path d="M7 10.5h6M7 13.5h4" />
    </>
  ),
};

export function RequestTypeIcon({
  type,
  conduit = false,
  size = 20,
  label,
}: {
  type: RequestType;
  conduit?: boolean;
  size?: number;
  label: string;
}): JSX.Element {
  return (
    <span className="needs-typeicon" role="img" aria-label={label}>
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {SHAPES[type]}
        {conduit ? (
          <path
            fill="currentColor"
            stroke="none"
            d="M16 10.6l2.8 1.1v2.2c0 1.8-1.2 3-2.8 3.7-1.6-.7-2.8-1.9-2.8-3.7v-2.2z"
          />
        ) : null}
      </svg>
    </span>
  );
}
