import type { DragEvent } from 'react';
import { insertionIndex } from '../src/reorder';

export function pointerInsertionIndex(e: DragEvent, itemSelector: string): number {
  const items = Array.from(e.currentTarget.querySelectorAll(itemSelector), (item) =>
    item.getBoundingClientRect(),
  );
  return insertionIndex(items, { x: e.clientX, y: e.clientY }, 'horizontal');
}

export function leftDropTarget(e: DragEvent): boolean {
  return !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget));
}
