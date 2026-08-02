import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type FileIconKind, fileIconKind } from '../../src/file-icon';
import { FileTypeIcon } from '../../webview/file-icons';
import * as ICON_EXPORTS from '../../webview/icons';
import { CHROME_ICONS, NEON_ICON_NAMES, SessionGlyph } from '../../webview/icons';
import { THEMES } from '../../webview/themes';

/**
 * The chrome icon set is theme-coupled through CSS, not through per-theme components: the
 * stroke shape comes off `.icon` and a Neon variant is picked by hiding one of two groups.
 * That only holds if the class hook, the tokens and the variant names stay in step — the three
 * things this file pins. A variant keyed to a glyph that does not exist would otherwise fall
 * back silently and look identical to a working one.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
const DRAWN = /<(path|rect|circle|ellipse|polyline|polygon|line)\b/;

const markup = (Icon: (p: { size?: number }) => JSX.Element) =>
  renderToStaticMarkup(createElement(Icon, { size: 16 }));

/** The two geometries a glyph can carry: the shared one, and Neon's override if it has one. */
function geometries(html: string): string[] {
  const base = /<g class="icon__geo">(.*?)<\/g>/s.exec(html);
  const neon = /<g class="icon__geo--neon">(.*?)<\/g>/s.exec(html);
  if (!base && !neon) return [html];
  if (!base || !neon) throw new Error('a variant glyph must render BOTH geometries');
  return [base[1], neon[1]];
}

describe('chrome icon set', () => {
  it('has glyphs', () => {
    expect(Object.keys(CHROME_ICONS).length).toBeGreaterThan(30);
  });

  for (const [name, Icon] of Object.entries(CHROME_ICONS)) {
    it(`${name}: carries the .icon hook and draws in every theme`, () => {
      const html = markup(Icon);
      expect(html).toMatch(/<svg[^>]*class="icon\b/);
      const shapes = geometries(html);
      expect(shapes).toHaveLength(NEON_ICON_NAMES.includes(name) ? 2 : 1);
      for (const g of shapes) expect(g).toMatch(DRAWN);
    });

    it(`${name}: leaves stroke shape to CSS`, () => {
      // A presentation attribute here would win against nothing — but it survives into the
      // markup and the next reader copies it, so the theme silently stops reaching that glyph.
      expect(markup(Icon)).not.toMatch(/stroke-(width|linecap|linejoin)=/);
    });
  }

  it('every Neon variant names a glyph in the base set', () => {
    for (const name of NEON_ICON_NAMES) expect(CHROME_ICONS).toHaveProperty(name);
  });

  it('forks only the glyphs CSS cannot sharpen', () => {
    expect(NEON_ICON_NAMES.length).toBeLessThan(Object.keys(CHROME_ICONS).length / 2);
  });

  it('is the whole chrome tier — no glyph renders outside the registry', () => {
    const registered = new Set(Object.values(CHROME_ICONS));
    for (const [name, exported] of Object.entries(ICON_EXPORTS)) {
      if (typeof exported !== 'function' || !name.startsWith('Icon')) continue;
      expect(registered.has(exported as (p: { size?: number }) => JSX.Element)).toBe(true);
    }
  });
});

describe('chrome icon tokens', () => {
  const iconRule = /\n\.icon \{([^}]*)\}/.exec(CSS)?.[1] ?? '';

  it('reads its stroke shape off the theme', () => {
    expect(iconRule).toMatch(/stroke-width: var\(--icon-stroke\)/);
    expect(iconRule).toMatch(/stroke-linecap: var\(--icon-cap\)/);
    expect(iconRule).toMatch(/stroke-linejoin: var\(--icon-join\)/);
  });

  it('every theme resolves the stroke tokens', () => {
    // :root carries Aero Dark, so a theme block only needs to state what it changes.
    const root = /:root \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '';
    for (const token of ['--icon-stroke', '--icon-cap', '--icon-join']) {
      expect(root).toContain(`${token}:`);
    }
    for (const { id } of THEMES) {
      if (id === 'aero-dark') continue;
      expect(CSS).toContain(`:root[data-theme="${id}"] {`);
    }
  });

  it('Neon squares off the authored rect radii', () => {
    expect(CSS).toMatch(/:root\[data-theme="neon"\] \{[\s\S]*?--icon-r: 0;/);
    expect(CSS).toMatch(/\[data-theme="neon"\] \.icon rect \{\s*rx: var\(--icon-r\);/);
  });
});

/**
 * The content tier is sharpened by CSS alone, because the family is a persisted contract:
 * `iconOverride` writes Lucide names into sessions.json (src/session-icon.ts), so swapping a
 * component would break every saved icon. Both halves need pinning — the names, and the
 * `.lucide` class the CSS hooks onto, which comes from lucide-react and not from us.
 *
 * Keyed by kind, so a new FileIconKind fails typecheck until it names its glyph here. The
 * class is not the import name: lucide-react's `*2` exports are aliases onto renamed glyphs.
 */
const CONTENT_GLYPHS: Record<FileIconKind, { file: string; lucide: string }> = {
  code: { file: 'app.ts', lucide: 'lucide-file-code-corner' },
  json: { file: 'package.json', lucide: 'lucide-file-braces-corner' },
  markdown: { file: 'README.md', lucide: 'lucide-file-text' },
  style: { file: 'theme.scss', lucide: 'lucide-palette' },
  web: { file: 'index.html', lucide: 'lucide-code-xml' },
  image: { file: 'logo.png', lucide: 'lucide-file-image' },
  shell: { file: 'run.sh', lucide: 'lucide-square-terminal' },
  config: { file: '.gitignore', lucide: 'lucide-settings-2' },
  doc: { file: 'notes.txt', lucide: 'lucide-file-text' },
  lock: { file: 'yarn.lock', lucide: 'lucide-file-lock' },
  generic: { file: 'mystery.qwerty', lucide: 'lucide-file' },
};

describe('content icon tier', () => {
  for (const [kind, { file, lucide }] of Object.entries(CONTENT_GLYPHS)) {
    it(`${kind}: still renders ${lucide}, carrying the .lucide hook`, () => {
      expect(fileIconKind(file)).toBe(kind);
      const html = renderToStaticMarkup(
        createElement(FileTypeIcon, { name: file, pack: 'minimal', size: 13 }),
      );
      expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide\b/);
      expect(html).toContain(lucide);
    });
  }

  it('a persisted session icon name resolves to the same Lucide glyph', () => {
    const html = renderToStaticMarkup(
      createElement(SessionGlyph, { icon: { type: 'lucide', name: 'rocket' }, size: 15 }),
    );
    expect(html).toContain('lucide-rocket');
  });

  it('Neon sharpens ends and corners; the other themes keep Lucide as drawn', () => {
    expect(CSS).toMatch(
      /\[data-theme="neon"\] \.lucide \{\s*stroke-linecap: var\(--icon-cap\);\s*stroke-linejoin: var\(--icon-join\);/,
    );
    expect(CSS).toMatch(/\[data-theme="neon"\] \.lucide rect \{\s*rx: var\(--icon-r\);/);
    // An unscoped rule would flatten Aero's radii too — the same trap --icon-r documents.
    expect(CSS).not.toMatch(/^\.lucide[\s{]/m);
  });
});
