/**
 * rehypePreserveLinkTarget — carry a link's original target past the sanitizer.
 *
 * `rehype-sanitize` only keeps an `href` whose scheme is in its protocol allow-list
 * (http/https/irc/ircs/mailto/xmpp). That silently destroys the two forms a local file
 * link takes before `MarkdownLink` can classify them:
 *
 *   [x](file:///c:/a/b.js)  scheme `file` — not allowed
 *   [x](C:/a/b.js)          scheme `c`    — a drive letter parses as a scheme
 *
 * so every absolute file link rendered inert. This copies the target into `data-md-href`
 * BEFORE sanitize runs; the schema allows that one attribute on `<a>`, and the sanitizer's
 * own `href` policy is left exactly as it was. A `data-*` attribute is inert — no browser
 * can navigate it — so the value is carried without becoming reachable, which an widened
 * `href` allow-list could not promise.
 *
 * Must be placed AFTER rehype-raw (so anchors from embedded HTML are covered too) and
 * BEFORE rehype-sanitize.
 */

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function rehypePreserveLinkTarget() {
  return (tree: HastNode) => {
    const walk = (node: HastNode): void => {
      if (node.tagName === 'a' && node.properties) {
        const href = node.properties.href;
        // Only a string target is worth carrying; sanitize drops the rest anyway.
        if (typeof href === 'string' && href !== '') node.properties.dataMdHref = href;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
