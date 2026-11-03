import { describe, expect, it } from 'vitest';
import { attentionChipLabel } from '../../src/attention';
import { CHROME_STR, clampPercent } from '../../webview/chrome-strings';

describe('CHROME_STR', () => {
  it('names the three views exactly as the selector contract does', () => {
    expect(CHROME_STR.view).toEqual({ files: 'Files', changes: 'Changes', messages: 'Messages' });
  });

  it('pluralises counts for 0, 1 and many', () => {
    expect(CHROME_STR.agents(0)).toBe('0 agents');
    expect(CHROME_STR.agents(1)).toBe('1 agent');
    expect(CHROME_STR.agents(3)).toBe('3 agents');
    expect(CHROME_STR.changesBadge(1)).toBe('1 change');
    expect(CHROME_STR.changesBadge(6)).toBe('6 changes');
  });

  it('describes unread messages, adding the urgent count only when there is one', () => {
    expect(CHROME_STR.messagesBadge(2, 0)).toBe('2 unread messages');
    expect(CHROME_STR.messagesBadge(1, 1)).toBe('1 unread message, 1 urgent message');
  });

  it('names unread messages outside the current scope only when there are some', () => {
    expect(CHROME_STR.messagesBadge(3, 0, 0)).toBe('3 unread messages');
    expect(CHROME_STR.messagesBadge(3, 1, 2)).toBe(
      '3 unread messages, 1 urgent message; 2 unread messages outside current scope',
    );
  });

  it('the footer need-you name is the existing chip copy, and empty at zero', () => {
    expect(CHROME_STR.needYou(1)).toBe(attentionChipLabel(1));
    expect(CHROME_STR.needYou(4)).toBe(attentionChipLabel(4));
    expect(CHROME_STR.needYou(0)).toBe('');
  });

  it('the command hint carries the bound combo verbatim', () => {
    expect(CHROME_STR.commands('Ctrl+Shift+P')).toBe('Ctrl+Shift+P commands');
  });

  it('update copy keeps the existing labels, with ? for a missing version', () => {
    expect(CHROME_STR.update.updating('2.0.0')).toBe('Updating to v2.0.0…');
    expect(CHROME_STR.update.updating(undefined)).toBe('Updating to v?…');
    expect(CHROME_STR.update.ready('2.0.0')).toBe('v2.0.0 ready');
    expect(CHROME_STR.update.relaunch).toBe('Relaunch to update');
    expect(CHROME_STR.update.percent(42)).toMatch(/42/);
  });
});

describe('clampPercent', () => {
  it('rounds finite values into 0–100 and falls back to 0', () => {
    expect(clampPercent(41.5)).toBe(42);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(250)).toBe(100);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
