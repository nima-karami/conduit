import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { PluggableList } from 'unified';
import { rehypePreserveLinkTarget } from './md-link-target';
import { markdownSanitizeSchema } from './md-sanitize';

// See docs/specs/archive/2026-11-03-whats-new.md: every notes surface uses the viewer's HTML guard.
export const MARKDOWN_SAFETY_PLUGINS: PluggableList = [
  rehypeRaw,
  rehypePreserveLinkTarget,
  [rehypeSanitize, markdownSanitizeSchema],
];
