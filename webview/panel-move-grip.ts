import type { DragEvent } from 'react';
import { isPanelDragTarget } from './drag-guard';

export interface MoveGrip {
  onDragStart: () => void;
  onDragEnd: () => void;
}

/**
 * Drag props that turn an element into a barless panel's move surface: dragging an
 * empty/background part of it re-docks the whole panel, while interactive children
 * (buttons) are excluded via isPanelDragTarget. Spread onto the element. A `undefined`
 * grip yields a non-draggable element.
 */
export function panelMoveDragProps(grip: MoveGrip | undefined): {
  draggable: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
} {
  if (!grip) return { draggable: false };
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      if (!isPanelDragTarget(e.target as Element, e.currentTarget)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      grip.onDragStart();
    },
    onDragEnd: grip.onDragEnd,
  };
}
