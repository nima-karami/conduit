import { describe, expect, it } from 'vitest';
import { alertLabel, matchAlertType, remarkAlerts } from '../../webview/md-alerts';

describe('matchAlertType', () => {
  it('matches all five GitHub alert types, case-insensitively', () => {
    expect(matchAlertType('[!NOTE]')).toBe('note');
    expect(matchAlertType('[!Tip] rest')).toBe('tip');
    expect(matchAlertType('[!important]\nbody')).toBe('important');
    expect(matchAlertType('[!WARNING]')).toBe('warning');
    expect(matchAlertType('[!caution]')).toBe('caution');
  });

  it('returns null for unknown or absent markers', () => {
    expect(matchAlertType('[!FOO]')).toBeNull();
    expect(matchAlertType('just text')).toBeNull();
    expect(matchAlertType('leading [!NOTE] not at start')).toBeNull();
    expect(matchAlertType('')).toBeNull();
  });
});

describe('alertLabel', () => {
  it('title-cases the type', () => {
    expect(alertLabel('note')).toBe('Note');
    expect(alertLabel('caution')).toBe('Caution');
  });
});

/** Minimal mdast blockquote with a single paragraph whose first text is `value`. */
// biome-ignore lint/suspicious/noExplicitAny: test fixtures use loose mdast shapes
function blockquote(value: string): any {
  return {
    type: 'blockquote',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  };
}
// biome-ignore lint/suspicious/noExplicitAny: test fixtures use loose mdast shapes
function tree(...children: any[]): any {
  return { type: 'root', children };
}

describe('remarkAlerts', () => {
  const run = remarkAlerts();

  it('transforms a [!NOTE] blockquote into an alert div with a title', () => {
    const bq = blockquote('[!NOTE]\nUseful info.');
    run(tree(bq));
    expect(bq.data.hName).toBe('div');
    expect(bq.data.hProperties.className).toEqual(['markdown-alert', 'markdown-alert-note']);
    expect(bq.data.hProperties.role).toBe('note');
    // title prepended
    expect(bq.children[0].data.hName).toBe('div');
    expect(bq.children[0].data.hProperties.className).toEqual(['markdown-alert-title']);
    expect(bq.children[0].children[0].value).toBe('Note');
    // marker stripped from body, content preserved
    expect(bq.children[1].children[0].value).toBe('Useful info.');
  });

  it('leaves a plain blockquote untouched', () => {
    const bq = blockquote('Just a quote, no marker.');
    run(tree(bq));
    expect(bq.data).toBeUndefined();
    expect(bq.children[0].children[0].value).toBe('Just a quote, no marker.');
  });

  it('handles a marker-only (empty body) alert: title only', () => {
    const bq = blockquote('[!WARNING]');
    run(tree(bq));
    expect(bq.data.hProperties.className).toEqual(['markdown-alert', 'markdown-alert-warning']);
    // only the title node remains (empty body paragraph dropped)
    expect(bq.children).toHaveLength(1);
    expect(bq.children[0].children[0].value).toBe('Warning');
  });

  it('does not transform an unknown marker type', () => {
    const bq = blockquote('[!FOO]\nbody');
    run(tree(bq));
    expect(bq.data).toBeUndefined();
  });
});
