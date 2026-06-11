import { describe, expect, it } from 'vitest';
import { nextChange, prevChange } from '../../webview/diff-nav';

describe('diff-nav', () => {
  describe('nextChange', () => {
    it('returns current line when list is empty', () => {
      expect(nextChange([], 5)).toBe(5);
    });

    it('wraps to first change when current is before all changes', () => {
      expect(nextChange([10, 20, 30], 5)).toBe(10);
    });

    it('advances to next change when between changes', () => {
      expect(nextChange([10, 20, 30], 15)).toBe(20);
    });

    it('wraps to first change when current is after last change', () => {
      expect(nextChange([10, 20, 30], 35)).toBe(10);
    });

    it('advances when exactly on a change', () => {
      expect(nextChange([10, 20, 30], 20)).toBe(30);
    });

    it('wraps when exactly on the last change', () => {
      expect(nextChange([10, 20, 30], 30)).toBe(10);
    });

    it('handles single change', () => {
      expect(nextChange([15], 5)).toBe(15);
      expect(nextChange([15], 15)).toBe(15);
      expect(nextChange([15], 25)).toBe(15);
    });
  });

  describe('prevChange', () => {
    it('returns current line when list is empty', () => {
      expect(prevChange([], 5)).toBe(5);
    });

    it('wraps to last change when current is before all changes', () => {
      expect(prevChange([10, 20, 30], 5)).toBe(30);
    });

    it('goes to previous change when between changes', () => {
      expect(prevChange([10, 20, 30], 25)).toBe(20);
    });

    it('wraps to last change when current is on first change', () => {
      expect(prevChange([10, 20, 30], 10)).toBe(30);
    });

    it('goes to previous when exactly on a middle change', () => {
      expect(prevChange([10, 20, 30], 20)).toBe(10);
    });

    it('goes to previous when exactly on a last change', () => {
      expect(prevChange([10, 20, 30], 30)).toBe(20);
    });

    it('handles single change', () => {
      expect(prevChange([15], 5)).toBe(15);
      expect(prevChange([15], 15)).toBe(15);
      expect(prevChange([15], 25)).toBe(15);
    });

    it('handles two changes correctly', () => {
      expect(prevChange([10, 20], 5)).toBe(20);
      expect(prevChange([10, 20], 10)).toBe(20);
      expect(prevChange([10, 20], 15)).toBe(10);
      expect(prevChange([10, 20], 20)).toBe(10);
      expect(prevChange([10, 20], 25)).toBe(20);
    });
  });
});
