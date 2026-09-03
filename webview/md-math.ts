/**
 * The markdown viewer's math delimiters.
 *
 * Two dollars for text math, never one. A single `$` in the documents and agent output this
 * app renders is currency ("$170,000 to $250,000"), a shell variable ($PATH) or a template
 * literal far more often than it is LaTeX — and with remark-math's default single-dollar text
 * math the PAIR of `$` is eaten as delimiters and everything between them is re-rendered in
 * KaTeX's math italic. The text silently changes instead of failing visibly, which is how it
 * was reported. `$$…$$` still renders real math.
 *
 * Lives here rather than inline in markdown-viewer.tsx so test/unit/md-math.test.ts can run the
 * REAL configuration: importing the viewer drags Monaco in, which does not load under jsdom.
 */
import type { ComponentProps } from 'react';
import type ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';

type RemarkPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>;

export const remarkMathPlugin: RemarkPlugins[number] = [
  remarkMath,
  { singleDollarTextMath: false },
];
