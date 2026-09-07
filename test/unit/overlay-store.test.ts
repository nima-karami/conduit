// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  getOverlays,
  nextOverlayId,
  registerOverlay,
  unregisterOverlay,
} from '../../webview/overlay-store';

describe('overlay-store', () => {
  it("Escape invokes only the top entry's onDismiss", () => {
    const idA = nextOverlayId();
    const idB = nextOverlayId();
    const onDismissA = vi.fn();
    const onDismissB = vi.fn();
    registerOverlay(idA, 'modal', onDismissA);
    registerOverlay(idB, 'modal', onDismissB);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onDismissB).toHaveBeenCalledTimes(1);
    expect(onDismissA).not.toHaveBeenCalled();

    unregisterOverlay(idB);
    unregisterOverlay(idA);
  });

  it('an entry registered after a modal receives Escape first', () => {
    const idModal = nextOverlayId();
    const idPopover = nextOverlayId();
    const onDismissModal = vi.fn();
    const onDismissPopover = vi.fn();
    registerOverlay(idModal, 'modal', onDismissModal);
    registerOverlay(idPopover, 'popover', onDismissPopover);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onDismissPopover).toHaveBeenCalledTimes(1);
    expect(onDismissModal).not.toHaveBeenCalled();

    unregisterOverlay(idPopover);
    unregisterOverlay(idModal);
  });

  it('Escape is stopped before bubble listeners', () => {
    const bubbleListener = vi.fn();
    window.addEventListener('keydown', bubbleListener);

    // Empty stack: no capture listener installed at all, so the event reaches the bubble listener.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bubbleListener).toHaveBeenCalledTimes(1);

    const id = nextOverlayId();
    const onDismiss = vi.fn();
    registerOverlay(id, 'modal', onDismiss);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(bubbleListener).toHaveBeenCalledTimes(1); // unchanged: stopPropagation ate this one

    unregisterOverlay(id);
    window.removeEventListener('keydown', bubbleListener);
  });

  it('registering a modal dismisses open popovers', () => {
    const idPopover = nextOverlayId();
    const idModal = nextOverlayId();
    const onDismissPopover = vi.fn();
    registerOverlay(idPopover, 'popover', onDismissPopover);

    registerOverlay(idModal, 'modal', vi.fn());

    expect(onDismissPopover).toHaveBeenCalledTimes(1);
    expect(getOverlays().some((e) => e.id === idPopover)).toBe(false);

    unregisterOverlay(idModal);
  });

  it("a dismissed popover's onDismiss that registers a new entry does not corrupt the stack", () => {
    const idPopover = nextOverlayId();
    const idModal = nextOverlayId();
    let idNew = -1;
    registerOverlay(idPopover, 'popover', () => {
      idNew = nextOverlayId();
      registerOverlay(idNew, 'popover', vi.fn());
    });

    registerOverlay(idModal, 'modal', vi.fn());

    expect(getOverlays().map((e) => e.id)).toEqual([idModal, idNew]);

    unregisterOverlay(idNew);
    unregisterOverlay(idModal);
  });

  it('the keydown listener is removed when the last entry unregisters', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const id = nextOverlayId();
    registerOverlay(id, 'modal', vi.fn());
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);

    unregisterOverlay(id);
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('getOverlays returns the same reference between changes', () => {
    const first = getOverlays();
    const second = getOverlays();
    expect(second).toBe(first);

    const id = nextOverlayId();
    registerOverlay(id, 'modal', vi.fn());
    const third = getOverlays();
    expect(third).not.toBe(second);

    unregisterOverlay(id);
  });
});
